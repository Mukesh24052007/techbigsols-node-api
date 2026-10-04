const crypto = require('crypto');
const { pool } = require('../config/db');
const { evaluateLocation } = require('../utils/geo');
const { decryptEmbedding } = require('../utils/crypto');
const { euclideanDistance, descriptorsIdentical, matchThreshold, minPairwiseDistance, replayEpsilon } = require('../utils/faceMath');
const { httpError } = require('../utils/attendanceValidate');
const { toUtcDateTime, fromUtcDateTime, istCalendarDate, istDateTimeToUtc } = require('../utils/time');
const AttendanceOfficeModel = require('../models/attendanceOffice.model.js');
const AttendanceProfileModel = require('../models/attendanceProfile.model.js');
const AttendanceAttemptModel = require('../models/attendanceAttempt.model.js');
const AttendanceChallengeModel = require('../models/attendanceChallenge.model.js');
const AttendanceRecordModel = require('../models/attendanceRecord.model.js');
const AttendancePresenceModel = require('../models/attendancePresence.model.js');
const AttendanceIntervalModel = require('../models/attendanceInterval.model.js');
const AttendanceReverifyModel = require('../models/attendanceReverify.model.js');

const ACTIONS = ['blink twice', 'turn left', 'turn right', 'smile'];
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_MAX = 5;
const LOCK_MS = 15 * 60 * 1000;
const CHALLENGE_TTL_MS = 60 * 1000;
const CHALLENGE_MIN_MS = 2 * 1000;
const CHALLENGE_MAX_MS = 45 * 1000;

async function loadProfileAndOffice(userId) {
  const profile = await AttendanceProfileModel.findByUserId(userId);
  if (!profile?.office_id) {
    throw httpError(400, 'No office is assigned to this employee.');
  }
  const office = await AttendanceOfficeModel.findById(profile.office_id);
  if (!office) {
    throw httpError(400, 'Assigned office was not found.');
  }
  return { profile, office };
}

function shiftTimes(profile, office) {
  return {
    shiftStart: profile.shift_start || office.shift_start,
    shiftEnd: profile.shift_end || office.shift_end,
    graceMinutes: office.grace_minutes,
  };
}

function isLate(office, profile, at = new Date()) {
  const { shiftStart, graceMinutes } = shiftTimes(profile, office);
  const start = istDateTimeToUtc(istCalendarDate(at), shiftStart);
  return at.getTime() > start.getTime() + graceMinutes * 60 * 1000;
}

async function assertNotLocked(userId) {
  const row = await AttendanceAttemptModel.latestRateLimitViolation(userId);
  if (!row) return;
  const created = fromUtcDateTime(row.created_at);
  if (!created) return;
  const unlockAt = created.getTime() + LOCK_MS;
  if (Date.now() < unlockAt) {
    const mins = Math.max(1, Math.ceil((unlockAt - Date.now()) / 60000));
    throw httpError(429, `Too many failed attempts. Try again in ${mins} minute(s).`);
  }
}

async function recordAttempt({ userId, kind, success, distanceScore, accuracy, ip, reason }) {
  await AttendanceAttemptModel.create({
    userId, kind, success, distanceScore, accuracy, ip, reason,
  });
  if (success) return;
  if (!['challenge', 'checkin', 'reverify'].includes(kind)) return;

  const since = toUtcDateTime(new Date(Date.now() - FAIL_WINDOW_MS));
  const n = await AttendanceAttemptModel.countRecentFailures(userId, since);
  if (n >= FAIL_MAX) {
    const existing = await AttendanceAttemptModel.latestRateLimitViolation(userId);
    const created = existing ? fromUtcDateTime(existing.created_at) : null;
    const stillLocked = created && Date.now() < created.getTime() + LOCK_MS;
    if (!stillLocked) {
      await AttendanceAttemptModel.create({
        userId,
        kind: 'violation',
        success: false,
        reason: 'rate_limit',
        ip,
      });
    }
  }
}

async function fail(opts) {
  await recordAttempt({ ...opts, success: false });
  throw httpError(opts.status || 400, opts.reason);
}

function requireConsent(profile, what) {
  if (!profile?.consent_at) {
    throw httpError(403, `Consent is required before ${what}.`);
  }
}

function assertLocation(office, lat, lng, accuracy, ip) {
  const result = evaluateLocation({ office, lat, lng, accuracy, ip });
  if (!result.ok) {
    throw httpError(400, result.reason || 'Location check failed.');
  }
  return result;
}

async function createChallenge({ userId, purpose, issuedAt = new Date() }) {
  const id = crypto.randomUUID();
  const issued = toUtcDateTime(issuedAt);
  const expires = toUtcDateTime(new Date(issuedAt.getTime() + CHALLENGE_TTL_MS));
  const action = ACTIONS[crypto.randomInt(0, ACTIONS.length)];
  await AttendanceChallengeModel.create({
    id,
    userId,
    purpose,
    action,
    issuedAt: issued,
    expiresAt: expires,
  });
  return { challengeId: id, action, expiresAt: new Date(issuedAt.getTime() + CHALLENGE_TTL_MS).toISOString() };
}

async function loadAndValidateChallenge({ challengeId, userId, purpose }) {
  if (!challengeId || typeof challengeId !== 'string') {
    throw httpError(400, 'challengeId is required.');
  }
  const row = await AttendanceChallengeModel.findById(challengeId);
  if (!row || row.user_id !== userId) {
    throw httpError(400, 'Challenge not found.');
  }
  if (row.purpose !== purpose) {
    throw httpError(400, 'Challenge purpose does not match.');
  }
  if (row.used_at) {
    throw httpError(400, 'Challenge has already been used.');
  }
  const issued = fromUtcDateTime(row.issued_at);
  const expires = fromUtcDateTime(row.expires_at);
  const now = Date.now();
  if (!issued || !expires || now > expires.getTime()) {
    throw httpError(400, 'Challenge has expired.');
  }
  const elapsed = now - issued.getTime();
  if (elapsed < CHALLENGE_MIN_MS) {
    throw httpError(400, 'Liveness capture was too fast. Retry the challenge.');
  }
  if (elapsed > CHALLENGE_MAX_MS) {
    throw httpError(400, 'Liveness capture took too long. Request a new challenge.');
  }
  return row;
}

function assertLivenessDescriptors(descriptors) {
  const min = minPairwiseDistance(descriptors);
  const eps = replayEpsilon();
  if (min < eps) {
    const err = httpError(400, 'Liveness failed: face samples look identical (possible photo replay).');
    err.attemptReason = `replay_detected:min_dist=${min.toFixed(6)}`;
    err.reason = err.attemptReason;
    err.distanceScore = Number.isFinite(min) ? Number(min.toFixed(6)) : null;
    throw err;
  }
}

function matchAll(descriptors, template) {
  const threshold = matchThreshold();
  let worst = 0;
  for (const d of descriptors) {
    const dist = euclideanDistance(d, template);
    if (dist > worst) worst = dist;
    if (dist > threshold) {
      return { ok: false, distance: dist };
    }
  }
  return { ok: true, distance: worst };
}

async function loadTemplate(userId) {
  const buf = await AttendanceProfileModel.getTemplate(userId);
  if (!buf) {
    throw httpError(400, 'Face is not enrolled for this employee.');
  }
  return decryptEmbedding(buf);
}

async function applyPresenceTransition({
  recordId,
  userId,
  nextState,
  reason = null,
  outsideStreak,
  weakStreak = 0,
  at,
  lat,
  lng,
  accuracy,
  expectedState,
  expectedLastHeartbeat,
}) {
  const presence = await AttendancePresenceModel.findByRecordId(recordId);
  const utc = toUtcDateTime(at);
  let lastInsideAt = presence?.last_inside_at || null;
  let outsideSince = presence?.outside_since || null;
  const streak = nextState === 'INSIDE' ? 0 : (outsideStreak !== undefined ? outsideStreak : (presence?.outside_streak || 1));

  if (nextState === 'INSIDE') {
    lastInsideAt = utc;
    outsideSince = null;
  } else if (nextState === 'OUTSIDE' || nextState === 'UNKNOWN') {
    if ((presence?.state !== 'OUTSIDE' && presence?.state !== 'UNKNOWN') || !outsideSince) {
      outsideSince = utc;
    }
  }

  if (!presence) {
    await AttendancePresenceModel.create(null, {
      recordId, userId, state: nextState, reason, outsideStreak: streak, weakStreak, at: utc, lat, lng, accuracy,
    });
    await AttendanceIntervalModel.open(null, { recordId, state: nextState, startedAt: utc });
    return { state: nextState, lastInsideAt, outsideSince };
  }

  if (presence.state !== nextState) {
    await AttendanceIntervalModel.closeOpen(recordId, utc);
    await AttendanceIntervalModel.open(null, { recordId, state: nextState, startedAt: utc });
  }

  const updated = await AttendancePresenceModel.updateConditional({
    recordId,
    expectedState: expectedState !== undefined ? expectedState : undefined,
    expectedLastHeartbeat: expectedLastHeartbeat !== undefined ? expectedLastHeartbeat : undefined,
    state: nextState,
    reason,
    outsideStreak: streak,
    weakStreak,
    at: utc,
    lat,
    lng,
    accuracy,
    lastInsideAt: nextState === 'INSIDE' ? utc : lastInsideAt,
    outsideSince,
  });

  return { success: updated, state: nextState, lastInsideAt, outsideSince };
}

async function createCheckInRecord({ user, office, profile, lat, lng, accuracy, ip }) {
  const now = new Date();
  const utc = toUtcDateTime(now);
  const attendanceDate = istCalendarDate(now);
  const status = isLate(office, profile, now) ? 'LATE' : 'PRESENT';

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const recordId = await AttendanceRecordModel.createCheckIn(conn, {
      userId: user.user_id,
      attendanceDate,
      fullname: user.fullname,
      officeId: office.id,
      checkInAt: utc,
      status,
      lat,
      lng,
      accuracy,
      ip,
    });
    await AttendancePresenceModel.create(conn, {
      recordId,
      userId: user.user_id,
      state: 'INSIDE',
      outsideStreak: 0,
      at: utc,
      lat,
      lng,
      accuracy,
    });
    await AttendanceIntervalModel.open(conn, { recordId, state: 'INSIDE', startedAt: utc });
    await conn.commit();
    return { recordId, status, attendanceDate, checkInAt: now.toISOString() };
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      throw httpError(409, 'Attendance already recorded for today.');
    }
    throw err;
  } finally {
    conn.release();
  }
}

function officePublicSubset(office) {
  if (!office) return null;
  const allow = office.ip_allowlist;
  const hasIpAllowlist = Array.isArray(allow) ? allow.length > 0 : Boolean(allow);
  return {
    id: office.id,
    name: office.name,
    lat: office.lat,
    lng: office.lng,
    radius_m: office.radius_m,
    accuracy_max_m: office.accuracy_max_m,
    heartbeat_seconds: office.heartbeat_seconds,
    shift_start: office.shift_start,
    shift_end: office.shift_end,
    grace_minutes: office.grace_minutes,
    outside_tolerance_minutes: office.outside_tolerance_minutes,
    reverify_count: office.reverify_count,
    require_both: office.require_both,
    hasIpAllowlist,
  };
}

module.exports = {
  ACTIONS,
  CHALLENGE_TTL_MS,
  loadProfileAndOffice,
  shiftTimes,
  isLate,
  assertNotLocked,
  recordAttempt,
  fail,
  requireConsent,
  assertLocation,
  createChallenge,
  loadAndValidateChallenge,
  assertLivenessDescriptors,
  matchAll,
  loadTemplate,
  applyPresenceTransition,
  createCheckInRecord,
  officePublicSubset,
  AttendanceRecordModel,
  AttendancePresenceModel,
  AttendanceIntervalModel,
  AttendanceReverifyModel,
  AttendanceChallengeModel,
};
