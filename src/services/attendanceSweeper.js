'use strict';

const { pool } = require('../config/db');
const {
  toUtcDateTime,
  fromUtcDateTime,
  istCalendarDate,
  istDateTimeToUtc,
} = require('../utils/time');
const { computeWorkedMinutes } = require('../utils/workedMinutes');
const attendanceBus = require('./attendanceBus');
const {
  applyPresenceTransition,
  recordAttempt,
} = require('./attendanceGate');

const AttendancePresenceModel = require('../models/attendancePresence.model');
const AttendanceIntervalModel = require('../models/attendanceInterval.model');
const AttendanceReverifyModel = require('../models/attendanceReverify.model');

let sweeperInterval = null;

/**
 * Sweeper core logic.
 * Idempotent: running multiple times in a row produces the same state.
 *
 * @param {Date} [now=new Date()]
 * @returns {Promise<Object>} Summary of actions taken
 */
async function performSweep(now = new Date()) {
  const nowUtc = toUtcDateTime(now);
  const todayIst = istCalendarDate(now);

  const [records] = await pool.query(
    `SELECT r.id, r.user_id, r.fullname, r.office_id,
            DATE_FORMAT(r.attendance_date, '%Y-%m-%d') AS attendance_date,
            DATE_FORMAT(r.check_in_at, '%Y-%m-%d %H:%i:%s') AS check_in_at,
            o.name AS office_name,
            TIME_FORMAT(o.shift_start, '%H:%i:%s') AS shift_start,
            TIME_FORMAT(o.shift_end, '%H:%i:%s') AS shift_end,
            o.grace_minutes,
            o.outside_tolerance_minutes,
            o.short_outing_allowance_minutes,
            o.heartbeat_seconds,
            o.reverify_count
     FROM attendance_records r
     LEFT JOIN attendance_offices o ON r.office_id = o.id
     WHERE r.check_out_at IS NULL`
  );

  let noSignalCount = 0;
  let toleranceAlertCount = 0;
  let reverifyViolations = 0;
  let reverifyScheduled = 0;
  let autoCheckoutCount = 0;

  if (!records.length) {
    return {
      scanned: 0,
      noSignalCount,
      toleranceAlertCount,
      reverifyViolations,
      reverifyScheduled,
      autoCheckoutCount,
    };
  }

  const recordIds = records.map((r) => r.id);

  // Batch Query 1: Fetch presence for all open records in ONE query
  const [presenceRows] = await pool.query(
    `SELECT record_id, user_id, state, reason, outside_streak, weak_streak,
            DATE_FORMAT(last_heartbeat_at, '%Y-%m-%d %H:%i:%s') AS last_heartbeat_at,
            DATE_FORMAT(last_inside_at, '%Y-%m-%d %H:%i:%s') AS last_inside_at,
            DATE_FORMAT(outside_since, '%Y-%m-%d %H:%i:%s') AS outside_since,
            last_lat, last_lng, last_accuracy,
            DATE_FORMAT(left_alerted_at, '%Y-%m-%d %H:%i:%s') AS left_alerted_at,
            DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
     FROM attendance_presence
     WHERE record_id IN (?)`,
    [recordIds]
  );
  const presenceMap = new Map();
  for (const row of presenceRows) {
    presenceMap.set(row.record_id, {
      ...row,
      last_lat: row.last_lat != null ? Number(row.last_lat) : null,
      last_lng: row.last_lng != null ? Number(row.last_lng) : null,
      last_accuracy: row.last_accuracy != null ? Number(row.last_accuracy) : null,
    });
  }

  // Batch Query 2: Fetch reverify tasks for all open records in ONE query
  const [taskRows] = await pool.query(
    `SELECT id, record_id, user_id,
            DATE_FORMAT(scheduled_at, '%Y-%m-%d %H:%i:%s') AS scheduled_at,
            DATE_FORMAT(due_at, '%Y-%m-%d %H:%i:%s') AS due_at,
            DATE_FORMAT(completed_at, '%Y-%m-%d %H:%i:%s') AS completed_at,
            status
     FROM attendance_reverify_tasks
     WHERE record_id IN (?)
     ORDER BY scheduled_at ASC`,
    [recordIds]
  );
  const tasksMap = new Map();
  for (const t of taskRows) {
    if (!tasksMap.has(t.record_id)) tasksMap.set(t.record_id, []);
    tasksMap.get(t.record_id).push(t);
  }

  for (const record of records) {
    const shiftEndHms = record.shift_end || '18:30:00';
    const shiftStartHms = record.shift_start || '09:30:00';
    const shiftEndUtc = istDateTimeToUtc(record.attendance_date, shiftEndHms);
    const shiftEndPlus15 = new Date(shiftEndUtc.getTime() + 15 * 60000);

    const isStaleDate = record.attendance_date < todayIst;
    const isPastShiftEndPlus15 = record.attendance_date === todayIst && now.getTime() >= shiftEndPlus15.getTime();

    // ── 3e & 3f. AUTO CHECKOUT ───────────────────────────────────────────────
    if (isStaleDate || isPastShiftEndPlus15) {
      const presence = await AttendancePresenceModel.findByRecordId(record.id);
      const closeTime = presence?.last_inside_at || record.check_in_at;
      const closeTimeUtc = toUtcDateTime(closeTime);

      // Close open intervals at closeTime
      await AttendanceIntervalModel.closeOpen(record.id, closeTimeUtc);

      const intervals = await AttendanceIntervalModel.findAllByRecord(record.id);
      const workedMinutes = computeWorkedMinutes({
        checkInAt: record.check_in_at,
        closeTime,
        intervals,
        toleranceMinutes: record.outside_tolerance_minutes != null ? record.outside_tolerance_minutes : 10,
        allowanceMinutes: record.short_outing_allowance_minutes != null ? record.short_outing_allowance_minutes : 30,
      });

      const [res] = await pool.query(
        `UPDATE attendance_records
         SET check_out_at = ?,
             worked_minutes = ?,
             status = 'AUTO_CHECKOUT',
             updated_at = ?
         WHERE id = ? AND check_out_at IS NULL`,
        [closeTimeUtc, workedMinutes, nowUtc, record.id]
      );

      if (res.affectedRows > 0) {
        // Cancel pending reverify tasks
        await pool.query(
          `UPDATE attendance_reverify_tasks
           SET status = 'MISSED'
           WHERE record_id = ? AND status = 'PENDING'`,
          [record.id]
        );

        attendanceBus.emit('auto_checkout', {
          employeeId: record.user_id,
          name: record.fullname,
          time: closeTimeUtc,
        });
        autoCheckoutCount++;
      }
      continue; // Record is closed; proceed to next
    }

    // ── 3a. NO SIGNAL ────────────────────────────────────────────────────────
    let presence = presenceMap.get(record.id);
    if (presence && presence.state === 'INSIDE') {
      const heartbeatIntervalSec = record.heartbeat_seconds != null ? record.heartbeat_seconds : 60;
      const noSignalThresholdMs = 2 * heartbeatIntervalSec * 1000;
      const refTime = presence.last_heartbeat_at || record.check_in_at;
      const refTimeDate = fromUtcDateTime(refTime);

      if (refTimeDate && (now.getTime() - refTimeDate.getTime() > noSignalThresholdMs)) {
        // Re-read presence inside sweep to avoid overwriting newer heartbeat
        const fresh = await AttendancePresenceModel.findByRecordId(record.id);
        const freshRef = fresh?.last_heartbeat_at || record.check_in_at;
        const freshRefDate = fromUtcDateTime(freshRef);
        if (fresh && fresh.state === 'INSIDE' && freshRefDate && (now.getTime() - freshRefDate.getTime() > noSignalThresholdMs)) {
          const transitioned = await applyPresenceTransition({
            recordId: record.id,
            userId: record.user_id,
            nextState: 'UNKNOWN',
            reason: 'no_signal',
            outsideStreak: 0,
            weakStreak: 0,
            at: now,
            expectedState: 'INSIDE',
            expectedLastHeartbeat: fresh.last_heartbeat_at,
          });
          if (transitioned.success) {
            noSignalCount++;
            presence = { ...presence, state: 'UNKNOWN', reason: 'no_signal' };
          }
        }
      }
    }

    // ── 3b. TOLERANCE ALERT ──────────────────────────────────────────────────
    if (presence && (presence.state === 'OUTSIDE' || presence.state === 'UNKNOWN')) {
      const toleranceMinutes = record.outside_tolerance_minutes != null ? record.outside_tolerance_minutes : 10;
      const outsideSince = presence.outside_since || presence.last_inside_at || record.check_in_at;
      const outsideSinceDate = fromUtcDateTime(outsideSince);
      const outsideMs = outsideSinceDate ? (now.getTime() - outsideSinceDate.getTime()) : 0;

      if (outsideMs >= toleranceMinutes * 60000 && !presence.left_alerted_at) {
        const updated = await AttendancePresenceModel.updateConditional({
          recordId: record.id,
          expectedState: presence.state,
          state: presence.state,
          reason: presence.reason,
          outsideStreak: presence.outside_streak,
          weakStreak: presence.weak_streak,
          lastInsideAt: presence.last_inside_at,
          outsideSince: presence.outside_since,
          leftAlertedAt: nowUtc,
        });

        if (updated) {
          const alertReason = presence.state === 'UNKNOWN'
            ? (presence.reason === 'weak_gps' ? 'weak_gps' : 'no_signal')
            : 'left';

          attendanceBus.emit('left_premises', {
            employeeId: record.user_id,
            name: record.fullname,
            time: nowUtc,
            reason: alertReason,
          });
          toleranceAlertCount++;
        }
      }
    }

    // ── 3d. RE-VERIFICATION ──────────────────────────────────────────────────
    const tasks = tasksMap.get(record.id) || [];

    // 1. Check for expired pending tasks (due for 5 minutes)
    for (const task of tasks) {
      const dueDate = fromUtcDateTime(task.due_at);
      if (task.status === 'PENDING' && dueDate && now.getTime() > dueDate.getTime()) {
        const heartbeatIntervalSec = record.heartbeat_seconds != null ? record.heartbeat_seconds : 60;
        const freshThresholdMs = 2 * heartbeatIntervalSec * 1000;
        const refTime = presence?.last_heartbeat_at || record.check_in_at;
        const refDate = fromUtcDateTime(refTime);
        const isHeartbeatFresh = refDate && (now.getTime() - refDate.getTime() <= freshThresholdMs);

        if (presence?.state === 'INSIDE' && isHeartbeatFresh) {
          const missed = await AttendanceReverifyModel.markMissed(task.id);
          if (missed) {
            await recordAttempt({
              userId: record.user_id,
              kind: 'violation',
              success: false,
              reason: 'reverify_missed',
              attemptedAt: nowUtc,
            }).catch(() => {});

            attendanceBus.emit('violation', {
              employeeId: record.user_id,
              name: record.fullname,
              time: nowUtc,
              reason: 'reverify_missed',
            });
            reverifyViolations++;
          }
        } else {
          // Task due window passed while presence was UNKNOWN or OUTSIDE -> SKIPPED (no violation)
          await AttendanceReverifyModel.markSkipped(task.id);
        }
      }
    }

    // 2. Schedule remaining tasks if fewer than N exist today
    const targetCount = Number(record.reverify_count) || 0;
    if (targetCount > 0 && tasks.length < targetCount) {
      const shiftStartUtc = istDateTimeToUtc(record.attendance_date, shiftStartHms);
      const shiftEndUtc = istDateTimeToUtc(record.attendance_date, shiftEndHms);
      const remainingCount = targetCount - tasks.length;
      const minGapMs = 60 * 60000;

      // Available window inside remaining shift
      const earliestScheduledMs = Math.max(now.getTime() + 5 * 60000, shiftStartUtc.getTime() + 60 * 60000);
      const latestScheduledMs = shiftEndUtc.getTime() - 15 * 60000;

      if (latestScheduledMs > earliestScheduledMs) {
        let lastScheduledMs = tasks.length > 0
          ? Math.max(...tasks.map((t) => (fromUtcDateTime(t.scheduled_at || t.due_at)?.getTime() || 0)))
          : earliestScheduledMs;

        for (let i = 0; i < remainingCount; i++) {
          const earliestPossible = Math.max(earliestScheduledMs + i * minGapMs, lastScheduledMs + minGapMs);
          const latestPossible = latestScheduledMs - (remainingCount - 1 - i) * minGapMs;
          if (earliestPossible <= latestPossible) {
            const scheduledMs = earliestPossible + Math.floor(Math.random() * (latestPossible - earliestPossible + 1));
            const scheduledAt = new Date(scheduledMs);
            const dueAt = new Date(scheduledMs + 5 * 60000);

            await AttendanceReverifyModel.schedule({
              recordId: record.id,
              userId: record.user_id,
              scheduledAt: toUtcDateTime(scheduledAt),
              dueAt: toUtcDateTime(dueAt),
            });
            lastScheduledMs = scheduledMs;
            reverifyScheduled++;
          }
        }
      }
    }
  }

  return {
    scanned: records.length,
    noSignalCount,
    toleranceAlertCount,
    reverifyViolations,
    reverifyScheduled,
    autoCheckoutCount,
  };
}

/**
 * Runs a single sweep with MySQL GET_LOCK for multi-instance safety.
 *
 * @param {Date} [now=new Date()]
 * @returns {Promise<Object>}
 */
async function sweepOnce(now = new Date()) {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query("SELECT GET_LOCK('attendance_sweeper', 0) AS lock_acquired");
    const lockAcquired = rows[0]?.lock_acquired === 1;

    if (!lockAcquired) {
      return { skipped: true, reason: 'lock_held' };
    }

    try {
      return await performSweep(now);
    } finally {
      await conn.query("SELECT RELEASE_LOCK('attendance_sweeper')");
    }
  } finally {
    conn.release();
  }
}

/**
 * Starts the sweeper background timer (every 30 seconds).
 */
function start() {
  if (sweeperInterval) return;

  sweeperInterval = setInterval(() => {
    sweepOnce(new Date()).catch((err) => {
      console.warn('⚠️  attendanceSweeper background error:', err.message);
    });
  }, 30000);

  if (typeof sweeperInterval.unref === 'function') {
    sweeperInterval.unref();
  }
  console.log('✅ Attendance sweeper started (interval: 30s)');
}

/**
 * Stops the sweeper background timer.
 */
function stop() {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
    console.log('🛑 Attendance sweeper stopped');
  }
}

module.exports = {
  start,
  stop,
  sweepOnce,
};
