'use strict';

require('dotenv').config();
const { pool } = require('../src/config/db');
const { computeWorkedMinutes } = require('../src/utils/workedMinutes');
const attendanceBus = require('../src/services/attendanceBus');
const attendanceSweeper = require('../src/services/attendanceSweeper');
const AttendancePresenceModel = require('../src/models/attendancePresence.model');
const AttendanceIntervalModel = require('../src/models/attendanceInterval.model');
const AttendanceRecordModel = require('../src/models/attendanceRecord.model');
const AttendanceReverifyModel = require('../src/models/attendanceReverify.model');
const { toUtcDateTime, fromUtcDateTime, sqlUtc, istCalendarDate, istDateTimeToUtc } = require('../src/utils/time');
const { haversineMetres } = require('../src/utils/geo');

// Safety guard: refuse to run against anything other than local DB
const dbHost = (process.env.DB_HOST || '').toLowerCase();
if (dbHost !== 'localhost' && dbHost !== '127.0.0.1') {
  console.error(`Refusing to run tests against DB_HOST "${dbHost}". Only localhost/127.0.0.1 is allowed.`);
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run tests in production NODE_ENV.');
  process.exit(1);
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  if (pass) {
    console.log(`✅ ${name}`);
  } else {
    console.error(`❌ ${name}${detail ? ` (${detail})` : ''}`);
  }
}

const FIXTURE_USER_1 = 'tbtst101';
const FIXTURE_USER_2 = 'tbtst102';
const FIXTURE_USER_3 = 'tbtst103';
const FIXTURE_USER_4 = 'tbtst104';
const FIXTURE_OFFICE_NAME = 'Phase 3 Test Office';
const OFFICE_LAT = 12.971598;
const OFFICE_LNG = 77.594566;

async function run() {
  console.log('🧪 Starting Phase 3 Presence Engine & Sweeper Tests...\n');

  // ── PART 1: Unit Tests for workedMinutes.js ───────────────────────────────
  console.log('--- Unit Tests: computeWorkedMinutes ---');

  // 1. One long outing (> tolerance) -> deduct full duration
  {
    // Shift: 09:00 to 17:00 (480 min). Outing: 10:00 to 10:45 (45 min > 10 min tolerance)
    const worked = computeWorkedMinutes({
      checkInAt: '2026-10-04 09:00:00',
      closeTime: '2026-10-04 17:00:00',
      intervals: [
        { state: 'INSIDE', started_at: '2026-10-04 09:00:00', ended_at: '2026-10-04 10:00:00' },
        { state: 'OUTSIDE', started_at: '2026-10-04 10:00:00', ended_at: '2026-10-04 10:45:00' },
        { state: 'INSIDE', started_at: '2026-10-04 10:45:00', ended_at: '2026-10-04 17:00:00' },
      ],
      toleranceMinutes: 10,
      allowanceMinutes: 30,
    });
    // Expected: 480 - 45 = 435
    record('workedMinutes: one long outing deducts full duration', worked === 435, `Got: ${worked}, expected: 435`);
  }

  // 2. Many 9-minute outings exceeding allowance
  {
    // Shift: 09:00 to 17:00 (480 min). 5 outings of 9 minutes = 45 min total.
    // Each outing <= 10 min tolerance. Allowance = 30 min.
    // Deduct: 45 - 30 = 15 min. Worked = 480 - 15 = 465 min.
    const intervals = [
      { state: 'INSIDE', started_at: '2026-10-04 09:00:00', ended_at: '2026-10-04 10:00:00' },
      { state: 'OUTSIDE', started_at: '2026-10-04 10:00:00', ended_at: '2026-10-04 10:09:00' },
      { state: 'INSIDE', started_at: '2026-10-04 10:09:00', ended_at: '2026-10-04 11:00:00' },
      { state: 'OUTSIDE', started_at: '2026-10-04 11:00:00', ended_at: '2026-10-04 11:09:00' },
      { state: 'INSIDE', started_at: '2026-10-04 11:09:00', ended_at: '2026-10-04 12:00:00' },
      { state: 'UNKNOWN', started_at: '2026-10-04 12:00:00', ended_at: '2026-10-04 12:09:00' },
      { state: 'INSIDE', started_at: '2026-10-04 12:09:00', ended_at: '2026-10-04 13:00:00' },
      { state: 'OUTSIDE', started_at: '2026-10-04 13:00:00', ended_at: '2026-10-04 13:09:00' },
      { state: 'INSIDE', started_at: '2026-10-04 13:09:00', ended_at: '2026-10-04 14:00:00' },
      { state: 'OUTSIDE', started_at: '2026-10-04 14:00:00', ended_at: '2026-10-04 14:09:00' },
      { state: 'INSIDE', started_at: '2026-10-04 14:09:00', ended_at: '2026-10-04 17:00:00' },
    ];
    const worked = computeWorkedMinutes({
      checkInAt: '2026-10-04 09:00:00',
      closeTime: '2026-10-04 17:00:00',
      intervals,
      toleranceMinutes: 10,
      allowanceMinutes: 30,
    });
    record('workedMinutes: many 9-minute outings exceeding allowance capped properly', worked === 465, `Got: ${worked}, expected: 465`);
  }

  // 3. An open final interval ends at closeTime
  {
    // Shift: 09:00 to 17:00 (480 min). Final OUTSIDE interval from 16:00 has ended_at = null.
    // Duration: 16:00 to 17:00 = 60 min (> 10 min tolerance). Deduct 60 min.
    // Worked: 480 - 60 = 420 min.
    const intervals = [
      { state: 'INSIDE', started_at: '2026-10-04 09:00:00', ended_at: '2026-10-04 16:00:00' },
      { state: 'OUTSIDE', started_at: '2026-10-04 16:00:00', ended_at: null },
    ];
    const worked = computeWorkedMinutes({
      checkInAt: '2026-10-04 09:00:00',
      closeTime: '2026-10-04 17:00:00',
      intervals,
      toleranceMinutes: 10,
      allowanceMinutes: 30,
    });
    record('workedMinutes: open final interval ends at closeTime', worked === 420, `Got: ${worked}, expected: 420`);
  }

  // 4. Intervals after closeTime (or last_inside_at) are ignored
  {
    // Shift: 09:00 to 17:00 (480 min). An OUTSIDE interval from 17:15 to 17:45 is outside span.
    const intervals = [
      { state: 'INSIDE', started_at: '2026-10-04 09:00:00', ended_at: '2026-10-04 17:00:00' },
      { state: 'OUTSIDE', started_at: '2026-10-04 17:15:00', ended_at: '2026-10-04 17:45:00' },
    ];
    const worked = computeWorkedMinutes({
      checkInAt: '2026-10-04 09:00:00',
      closeTime: '2026-10-04 17:00:00',
      intervals,
      toleranceMinutes: 10,
      allowanceMinutes: 30,
    });
    record('workedMinutes: intervals after closeTime are ignored', worked === 480, `Got: ${worked}, expected: 480`);
  }

  // ── PART 2: Database Integration Tests with sweepOnce(fakeNow) ───────────
  console.log('\n--- Integration Tests: sweepOnce and Events ---');

  let testOfficeId = null;
  const busEvents = [];
  const unsubscribeBus = attendanceBus.subscribe((evt) => {
    busEvents.push(evt);
  });

  try {
    // Clean any residual test fixtures
    await pool.query('DELETE FROM attendance_profiles WHERE user_id IN (?, ?, ?, ?)', [FIXTURE_USER_1, FIXTURE_USER_2, FIXTURE_USER_3, FIXTURE_USER_4]);
    await pool.query('DELETE FROM site_users WHERE user_id IN (?, ?, ?, ?)', [FIXTURE_USER_1, FIXTURE_USER_2, FIXTURE_USER_3, FIXTURE_USER_4]);
    await pool.query('DELETE FROM attendance_offices WHERE name = ?', [FIXTURE_OFFICE_NAME]);

    // Create test office with:
    // heartbeat_seconds = 30 (no-signal threshold = 60s)
    // outside_tolerance_minutes = 5
    // short_outing_allowance_minutes = 20
    // reverify_count = 1
    // shift_start = '09:00:00', shift_end = '18:00:00'
    const [officeRes] = await pool.query(
      `INSERT INTO attendance_offices
        (name, lat, lng, radius_m, accuracy_max_m, ip_allowlist, require_both,
         shift_start, shift_end, grace_minutes, outside_tolerance_minutes,
         short_outing_allowance_minutes, heartbeat_seconds, reverify_count,
         created_at, updated_at)
       VALUES (?, ?, ?, 150, 50, NULL, 0, '09:00:00', '18:00:00', 10, 5, 20, 30, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [FIXTURE_OFFICE_NAME, OFFICE_LAT, OFFICE_LNG]
    );
    testOfficeId = officeRes.insertId;

    // Create fixture user 1
    await pool.query(
      `INSERT INTO site_users (user_id, fullname, email, password, module_access, is_active, created_at, updated_at)
       VALUES (?, 'Phase3 User 1', 'p3_u1@test.com', 'dummy_hash', JSON_ARRAY('Attendance'), 1, NOW(), NOW())`,
      [FIXTURE_USER_1]
    );
    await pool.query(
      `INSERT INTO attendance_profiles (user_id, office_id, consent_at, consent_version, created_at, updated_at)
       VALUES (?, ?, UTC_TIMESTAMP(), 'v1', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [FIXTURE_USER_1, testOfficeId]
    );

    // 5. Test Events Received by a Subscriber
    {
      busEvents.length = 0;
      attendanceBus.emit('checkin', { employeeId: FIXTURE_USER_1, name: 'Phase3 User 1', time: new Date() });
      const received = busEvents.find((e) => e.type === 'checkin' && e.employeeId === FIXTURE_USER_1);
      record('events received by a subscriber', Boolean(received));
    }

    // 6. Test INSIDE -> No heartbeats -> UNKNOWN -> left_premises once (not repeated)
    {
      busEvents.length = 0;
      const baseTime = new Date('2026-10-04T10:00:00Z');
      const baseTimeUtc = toUtcDateTime(baseTime);

      // Create open record for User 1
      const [recRes] = await pool.query(
        `INSERT INTO attendance_records
          (user_id, attendance_date, fullname, office_id, check_in_at, status, worked_minutes, created_at, updated_at)
         VALUES (?, '2026-10-04', 'Phase3 User 1', ?, ?, 'PRESENT', 0, ?, ?)`,
        [FIXTURE_USER_1, testOfficeId, baseTimeUtc, baseTimeUtc, baseTimeUtc]
      );
      const recordId = recRes.insertId;

      await AttendancePresenceModel.create(null, {
        recordId,
        userId: FIXTURE_USER_1,
        state: 'INSIDE',
        reason: null,
        outsideStreak: 0,
        weakStreak: 0,
        at: baseTimeUtc,
        lat: OFFICE_LAT,
        lng: OFFICE_LNG,
        accuracy: 10,
      });
      await AttendanceIntervalModel.open(null, { recordId, state: 'INSIDE', startedAt: baseTimeUtc });

      // Run sweeper 20s later: heartbeat_seconds is 30, threshold is 60s -> still INSIDE
      await attendanceSweeper.sweepOnce(new Date(baseTime.getTime() + 20000));
      let pres = await AttendancePresenceModel.findByRecordId(recordId);
      record('sweeper: inside before threshold stays INSIDE', pres.state === 'INSIDE');

      // Run sweeper 70s later (> 60s threshold): transitions to UNKNOWN (reason 'no_signal')
      await attendanceSweeper.sweepOnce(new Date(baseTime.getTime() + 70000));
      pres = await AttendancePresenceModel.findByRecordId(recordId);
      record('sweeper: no heartbeats past 2x heartbeat_seconds transitions to UNKNOWN', pres.state === 'UNKNOWN' && pres.reason === 'no_signal');

      // Advance time past outside_tolerance_minutes (5 min = 300s): run sweeper at baseTime + 400s
      busEvents.length = 0;
      await attendanceSweeper.sweepOnce(new Date(baseTime.getTime() + 400000));
      pres = await AttendancePresenceModel.findByRecordId(recordId);
      const leftEvent = busEvents.find((e) => e.type === 'left_premises' && e.employeeId === FIXTURE_USER_1);
      const alertedOnce = Boolean(leftEvent && leftEvent.reason === 'no_signal' && pres.left_alerted_at);

      // Run sweeper again at baseTime + 450s: must NOT repeat left_premises event
      const eventCountBefore = busEvents.length;
      await attendanceSweeper.sweepOnce(new Date(baseTime.getTime() + 450000));
      const notRepeated = busEvents.length === eventCountBefore;
      record('sweeper: left_premises emitted once with reason no_signal (not repeated)', alertedOnce && notRepeated);

      // Clean up User 1 record
      await pool.query('DELETE FROM attendance_intervals WHERE record_id = ?', [recordId]);
      await pool.query('DELETE FROM attendance_presence WHERE record_id = ?', [recordId]);
      await pool.query('DELETE FROM attendance_records WHERE id = ?', [recordId]);
    }

    // 7. Test OUTSIDE under tolerance returns with no deduction
    {
      const checkInTime = new Date('2026-10-04T09:30:00Z');
      const [recRes] = await pool.query(
        `INSERT INTO attendance_records
          (user_id, attendance_date, fullname, office_id, check_in_at, status, worked_minutes, created_at, updated_at)
         VALUES (?, '2026-10-04', 'Phase3 User 1', ?, ?, 'PRESENT', 0, ?, ?)`,
        [FIXTURE_USER_1, testOfficeId, toUtcDateTime(checkInTime), toUtcDateTime(checkInTime), toUtcDateTime(checkInTime)]
      );
      const recordId = recRes.insertId;

      // Intervals:
      // INSIDE: 09:30 to 10:00 (30m)
      // OUTSIDE: 10:00 to 10:04 (4m <= 5m tolerance)
      // INSIDE: 10:04 to 17:30 (446m)
      // Total span: 09:30 to 17:30 = 8h = 480m. Outing <= 5m tolerance -> 0 deduction.
      await AttendanceIntervalModel.open(null, { recordId, state: 'INSIDE', startedAt: '2026-10-04 09:30:00' });
      await AttendanceIntervalModel.closeOpen(recordId, '2026-10-04 10:00:00');
      await AttendanceIntervalModel.open(null, { recordId, state: 'OUTSIDE', startedAt: '2026-10-04 10:00:00' });
      await AttendanceIntervalModel.closeOpen(recordId, '2026-10-04 10:04:00');
      await AttendanceIntervalModel.open(null, { recordId, state: 'INSIDE', startedAt: '2026-10-04 10:04:00' });
      await AttendanceIntervalModel.closeOpen(recordId, '2026-10-04 17:30:00');

      const intervals = await AttendanceIntervalModel.findAllByRecord(recordId);
      const worked = computeWorkedMinutes({
        checkInAt: '2026-10-04 09:30:00',
        closeTime: '2026-10-04 17:30:00',
        intervals,
        toleranceMinutes: 5,
        allowanceMinutes: 20,
      });
      record('OUTSIDE under tolerance returns with no deduction', worked === 480, `Got: ${worked}, expected: 480`);

      await pool.query('DELETE FROM attendance_intervals WHERE record_id = ?', [recordId]);
      await pool.query('DELETE FROM attendance_records WHERE id = ?', [recordId]);
    }

    // 8. Test OUTSIDE over tolerance returns with the correct deduction
    {
      const checkInTime = new Date('2026-10-04T09:30:00Z');
      const [recRes] = await pool.query(
        `INSERT INTO attendance_records
          (user_id, attendance_date, fullname, office_id, check_in_at, status, worked_minutes, created_at, updated_at)
         VALUES (?, '2026-10-04', 'Phase3 User 1', ?, ?, 'PRESENT', 0, ?, ?)`,
        [FIXTURE_USER_1, testOfficeId, toUtcDateTime(checkInTime), toUtcDateTime(checkInTime), toUtcDateTime(checkInTime)]
      );
      const recordId = recRes.insertId;

      // Intervals:
      // INSIDE: 09:30 to 10:00 (30m)
      // OUTSIDE: 10:00 to 10:45 (45m > 5m tolerance -> deduct full 45m)
      // INSIDE: 10:45 to 17:30 (405m)
      // Total span: 480m. Deduction = 45m. Worked = 435m.
      await AttendanceIntervalModel.open(null, { recordId, state: 'INSIDE', startedAt: '2026-10-04 09:30:00' });
      await AttendanceIntervalModel.closeOpen(recordId, '2026-10-04 10:00:00');
      await AttendanceIntervalModel.open(null, { recordId, state: 'OUTSIDE', startedAt: '2026-10-04 10:00:00' });
      await AttendanceIntervalModel.closeOpen(recordId, '2026-10-04 10:45:00');
      await AttendanceIntervalModel.open(null, { recordId, state: 'INSIDE', startedAt: '2026-10-04 10:45:00' });
      await AttendanceIntervalModel.closeOpen(recordId, '2026-10-04 17:30:00');

      const intervals = await AttendanceIntervalModel.findAllByRecord(recordId);
      const worked = computeWorkedMinutes({
        checkInAt: '2026-10-04 09:30:00',
        closeTime: '2026-10-04 17:30:00',
        intervals,
        toleranceMinutes: 5,
        allowanceMinutes: 20,
      });
      record('OUTSIDE over tolerance returns with the correct deduction', worked === 435, `Got: ${worked}, expected: 435`);

      await pool.query('DELETE FROM attendance_intervals WHERE record_id = ?', [recordId]);
      await pool.query('DELETE FROM attendance_records WHERE id = ?', [recordId]);
    }

    // 9. Test Re-verify task scheduled, then missed, then violation row
    {
      const checkInTime = new Date('2026-10-04T09:30:00Z');
      const [recRes] = await pool.query(
        `INSERT INTO attendance_records
          (user_id, attendance_date, fullname, office_id, check_in_at, status, worked_minutes, created_at, updated_at)
         VALUES (?, '2026-10-04', 'Phase3 User 1', ?, ?, 'PRESENT', 0, ?, ?)`,
        [FIXTURE_USER_1, testOfficeId, toUtcDateTime(checkInTime), toUtcDateTime(checkInTime), toUtcDateTime(checkInTime)]
      );
      const recordId = recRes.insertId;

      await AttendancePresenceModel.create(null, {
        recordId,
        userId: FIXTURE_USER_1,
        state: 'INSIDE',
        reason: null,
        outsideStreak: 0,
        weakStreak: 0,
        at: toUtcDateTime(checkInTime),
        lat: OFFICE_LAT,
        lng: OFFICE_LNG,
        accuracy: 10,
      });

      // Run sweeper to schedule reverify task (office reverify_count = 1)
      const sweepNow = new Date('2026-10-04T10:00:00Z');
      await attendanceSweeper.sweepOnce(sweepNow);

      const tasks = await AttendanceReverifyModel.findByRecord(recordId);
      const scheduled = tasks.length > 0 && tasks[0].status === 'PENDING';
      record('sweeper: reverify task scheduled when fewer than N exist', scheduled);

      // Now simulate task expiration: advance time past due_at (which is scheduled_at + 5 min)
      if (tasks.length > 0) {
        const dueTime = fromUtcDateTime(tasks[0].due_at);
        const expiredNow = new Date(dueTime.getTime() + 60000); // 1 minute after due_at

        busEvents.length = 0;
        await attendanceSweeper.sweepOnce(expiredNow);

        const updatedTasks = await AttendanceReverifyModel.findByRecord(recordId);
        const isMissed = updatedTasks[0].status === 'MISSED';

        const [attemptRows] = await pool.query(
          `SELECT kind, reason FROM attendance_attempts WHERE user_id = ? AND kind = 'violation' ORDER BY id DESC LIMIT 1`,
          [FIXTURE_USER_1]
        );
        const hasViolationAttempt = attemptRows[0]?.reason === 'reverify_missed';
        const violationEvent = busEvents.find((e) => e.type === 'violation' && e.employeeId === FIXTURE_USER_1);

        record('sweeper: expired reverify task marked MISSED with violation row and event', isMissed && hasViolationAttempt && Boolean(violationEvent));
      }

      await pool.query('DELETE FROM attendance_reverify_tasks WHERE record_id = ?', [recordId]);
      await pool.query('DELETE FROM attendance_attempts WHERE user_id = ?', [FIXTURE_USER_1]);
      await pool.query('DELETE FROM attendance_presence WHERE record_id = ?', [recordId]);
      await pool.query('DELETE FROM attendance_records WHERE id = ?', [recordId]);
    }

    // 10. Test Auto-checkout at the last INSIDE time
    {
      // Shift end is 18:00:00 IST. 15 min grace -> 18:15:00 IST.
      // IST 18:15 is UTC 12:45. Let's run sweep at UTC 13:00 (18:30 IST).
      // Check in at 09:00 IST (UTC 03:30). Last inside at 17:00 IST (UTC 11:30).
      const checkInUtc = '2026-10-04 03:30:00';
      const lastInsideUtc = '2026-10-04 11:30:00';

      const [recRes] = await pool.query(
        `INSERT INTO attendance_records
          (user_id, attendance_date, fullname, office_id, check_in_at, status, worked_minutes, created_at, updated_at)
         VALUES (?, '2026-10-04', 'Phase3 User 1', ?, ?, 'PRESENT', 0, ?, ?)`,
        [FIXTURE_USER_1, testOfficeId, checkInUtc, checkInUtc, checkInUtc]
      );
      const recordId = recRes.insertId;

      await AttendancePresenceModel.create(null, {
        recordId,
        userId: FIXTURE_USER_1,
        state: 'OUTSIDE',
        reason: 'left',
        outsideStreak: 1,
        weakStreak: 0,
        at: checkInUtc,
        lat: OFFICE_LAT,
        lng: OFFICE_LNG,
        accuracy: 10,
      });
      await AttendancePresenceModel.updateConditional({
        recordId,
        state: 'OUTSIDE',
        lastInsideAt: lastInsideUtc,
        outsideSince: lastInsideUtc,
      });

      await AttendanceIntervalModel.open(null, { recordId, state: 'INSIDE', startedAt: checkInUtc });
      await AttendanceIntervalModel.closeOpen(recordId, lastInsideUtc);
      await AttendanceIntervalModel.open(null, { recordId, state: 'OUTSIDE', startedAt: lastInsideUtc });

      // Fake clock at 18:30 IST = UTC 13:00:00
      const sweepNow = new Date('2026-10-04T13:00:00Z');
      busEvents.length = 0;
      await attendanceSweeper.sweepOnce(sweepNow);

      const [recRows] = await pool.query(`SELECT status, ${sqlUtc('check_out_at')}, worked_minutes FROM attendance_records WHERE id = ?`, [recordId]);
      const closedRecord = recRows[0];
      const autoCheckoutEvt = busEvents.find((e) => e.type === 'auto_checkout' && e.employeeId === FIXTURE_USER_1);

      // Check-out time should be exactly lastInsideUtc (11:30:00)
      const correctCloseTime = String(closedRecord?.check_out_at).includes('11:30:00');
      const isAutoCheckout = closedRecord?.status === 'AUTO_CHECKOUT';

      record('sweeper: auto checkout at last INSIDE time after shift end + 15 min', isAutoCheckout && correctCloseTime && Boolean(autoCheckoutEvt));

      await pool.query('DELETE FROM attendance_intervals WHERE record_id = ?', [recordId]);
      await pool.query('DELETE FROM attendance_presence WHERE record_id = ?', [recordId]);
      await pool.query('DELETE FROM attendance_records WHERE id = ?', [recordId]);
    }

    // 11. Test Stale previous-day record closed
    {
      const checkInUtc = '2026-10-03 04:00:00';
      const lastInsideUtc = '2026-10-03 12:00:00';

      const [recRes] = await pool.query(
        `INSERT INTO attendance_records
          (user_id, attendance_date, fullname, office_id, check_in_at, status, worked_minutes, created_at, updated_at)
         VALUES (?, '2026-10-03', 'Phase3 User 1', ?, ?, 'PRESENT', 0, ?, ?)`,
        [FIXTURE_USER_1, testOfficeId, checkInUtc, checkInUtc, checkInUtc]
      );
      const recordId = recRes.insertId;

      await AttendancePresenceModel.create(null, {
        recordId,
        userId: FIXTURE_USER_1,
        state: 'INSIDE',
        reason: null,
        outsideStreak: 0,
        weakStreak: 0,
        at: checkInUtc,
        lat: OFFICE_LAT,
        lng: OFFICE_LNG,
        accuracy: 10,
      });
      await AttendancePresenceModel.updateConditional({
        recordId,
        state: 'INSIDE',
        lastInsideAt: lastInsideUtc,
      });

      // Today is 2026-10-04
      const sweepNow = new Date('2026-10-04T05:00:00Z');
      busEvents.length = 0;
      await attendanceSweeper.sweepOnce(sweepNow);

      const [recRows] = await pool.query(`SELECT status, ${sqlUtc('check_out_at')} FROM attendance_records WHERE id = ?`, [recordId]);
      const closedRecord = recRows[0];
      const isAutoCheckout = closedRecord?.status === 'AUTO_CHECKOUT';
      const correctCloseTime = String(closedRecord?.check_out_at).includes('12:00:00');

      record('sweeper: stale previous-day record closed at last INSIDE time', isAutoCheckout && correctCloseTime);

      await pool.query('DELETE FROM attendance_intervals WHERE record_id = ?', [recordId]);
      await pool.query('DELETE FROM attendance_presence WHERE record_id = ?', [recordId]);
      await pool.query('DELETE FROM attendance_records WHERE id = ?', [recordId]);
    }

    // 12. Test Concurrency: MySQL GET_LOCK prevents double processing
    {
      const conn = await pool.getConnection();
      try {
        // Acquire lock manually on dedicated connection
        const [lockRes] = await conn.query("SELECT GET_LOCK('attendance_sweeper', 0) AS lock_acquired");
        const manualLockAcquired = lockRes[0]?.lock_acquired === 1;

        if (manualLockAcquired) {
          // Calling sweepOnce now should fail to acquire lock and skip
          const sweepRes = await attendanceSweeper.sweepOnce(new Date());
          const skipped = sweepRes?.skipped === true && sweepRes?.reason === 'lock_held';
          record('sweeper: concurrent sweep skipped when GET_LOCK held by another instance', skipped);

          await conn.query("SELECT RELEASE_LOCK('attendance_sweeper')");
        } else {
          record('sweeper: concurrent lock test setup', false, 'Could not acquire initial manual lock');
        }
      } finally {
        conn.release();
      }
    }

    // 13. Test Race Condition Guard: Conditional Update prevents overwriting newer heartbeat
    {
      const checkInUtc = '2026-10-04 10:00:00';
      const [recRes] = await pool.query(
        `INSERT INTO attendance_records
          (user_id, attendance_date, fullname, office_id, check_in_at, status, worked_minutes, created_at, updated_at)
         VALUES (?, '2026-10-04', 'Phase3 User 1', ?, ?, 'PRESENT', 0, ?, ?)`,
        [FIXTURE_USER_1, testOfficeId, checkInUtc, checkInUtc, checkInUtc]
      );
      const recordId = recRes.insertId;

      await AttendancePresenceModel.create(null, {
        recordId,
        userId: FIXTURE_USER_1,
        state: 'INSIDE',
        reason: null,
        outsideStreak: 0,
        weakStreak: 0,
        at: checkInUtc,
        lat: OFFICE_LAT,
        lng: OFFICE_LNG,
        accuracy: 10,
      });

      // Simulate: a new heartbeat arrived with updated last_heartbeat_at = '2026-10-04 10:02:00'
      const newerHeartbeatUtc = '2026-10-04 10:02:00';
      await AttendancePresenceModel.updateConditional({
        recordId,
        expectedState: 'INSIDE',
        state: 'INSIDE',
        at: newerHeartbeatUtc,
      });

      // Sweeper tries to update conditionally expecting stale heartbeat ('2026-10-04 10:00:00')
      const staleUpdateSuccess = await AttendancePresenceModel.updateConditional({
        recordId,
        expectedState: 'INSIDE',
        expectedLastHeartbeat: checkInUtc, // STALE!
        state: 'UNKNOWN',
        reason: 'no_signal',
      });

      const currentPres = await AttendancePresenceModel.findByRecordId(recordId);
      const preservedNewerState = staleUpdateSuccess === false && currentPres.state === 'INSIDE';

      record('conditional update: sweeper rejects write if heartbeat arrived concurrently', preservedNewerState);

      await pool.query('DELETE FROM attendance_presence WHERE record_id = ?', [recordId]);
      await pool.query('DELETE FROM attendance_records WHERE id = ?', [recordId]);
    }

  } finally {
    unsubscribeBus();
    console.log('\n🧹 Cleaning up Phase 3 fixtures...');
    await pool.query('DELETE FROM attendance_profiles WHERE user_id IN (?, ?, ?, ?)', [FIXTURE_USER_1, FIXTURE_USER_2, FIXTURE_USER_3, FIXTURE_USER_4]);
    await pool.query('DELETE FROM site_users WHERE user_id IN (?, ?, ?, ?)', [FIXTURE_USER_1, FIXTURE_USER_2, FIXTURE_USER_3, FIXTURE_USER_4]);
    if (testOfficeId) {
      await pool.query('DELETE FROM attendance_offices WHERE id = ?', [testOfficeId]);
    }
    console.log('✅ Fixtures cleaned up cleanly.\n');
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log('========================================');
  console.log(`Phase 3 Test Results: ${passed}/${total} passed`);
  console.log('========================================\n');

  await pool.end();
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
