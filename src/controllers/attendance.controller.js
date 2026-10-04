const crypto = require('crypto');
const { pool } = require('../config/db');
const {
  httpError,
  finiteNumber,
  assertLatLngAccuracy,
  assertDescriptors,
  clientIp,
  parseMonth,
  parseIsoDate,
} = require('../utils/attendanceValidate');
const { haversineMetres } = require('../utils/geo');
const { encryptEmbedding } = require('../utils/crypto');
const {
  euclideanDistance,
  averageDescriptors,
  minPairwiseDistance,
  replayEpsilon,
} = require('../utils/faceMath');
const { toUtcDateTime, istCalendarDate } = require('../utils/time');
const { computeWorkedMinutes } = require('../utils/workedMinutes');
const attendanceBus = require('../services/attendanceBus');

const {
  loadProfileAndOffice,
  assertNotLocked,
  recordAttempt,
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
} = require('../services/attendanceGate');

const AttendanceRecordModel = require('../models/attendanceRecord.model');
const AttendancePresenceModel = require('../models/attendancePresence.model');
const AttendanceIntervalModel = require('../models/attendanceInterval.model');
const AttendanceReverifyModel = require('../models/attendanceReverify.model');
const AttendanceChallengeModel = require('../models/attendanceChallenge.model');
const AttendanceProfileModel = require('../models/attendanceProfile.model');
const AttendanceOfficeModel = require('../models/attendanceOffice.model');
const AttendanceRegularizationModel = require('../models/attendanceRegularization.model');
const AttendanceAuditLogModel = require('../models/attendanceAuditLog.model');

const AttendanceController = {
  /**
   * GET /api/attendance/ping
   */
  async ping(req, res, next) {
    try {
      return res.status(200).json({
        success: true,
        message: 'attendance ok',
        data: { module: 'attendance' },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/attendance/me/status
   */
  async getStatus(req, res, next) {
    try {
      const userId = req.siteUser.user_id;
      const { profile, office } = await loadProfileAndOffice(userId);
      const consentGiven = Boolean(profile.consent_at);
      const faceEnrolled = Boolean(profile.face_enrolled_at);
      const today = istCalendarDate(new Date());
      const todayRecord = await AttendanceRecordModel.findByUserDate(userId, today);
      const presence = todayRecord ? await AttendancePresenceModel.findByRecordId(todayRecord.id) : null;
      const pendingTask = todayRecord ? await AttendanceReverifyModel.pendingForRecord(todayRecord.id) : null;

      return res.status(200).json({
        success: true,
        data: {
          office: officePublicSubset(office),
          faceEnrolled,
          consentGiven,
          consentAt: profile.consent_at,
          todayRecord,
          presenceState: presence ? presence.state : null,
          reverifyPending: Boolean(pendingTask),
          reverifyDueAt: pendingTask?.due_at || null,
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/attendance/me/consent
   */
  async recordConsent(req, res, next) {
    try {
      const userId = req.siteUser.user_id;
      const version = req.body?.version ? String(req.body.version).trim().slice(0, 32) : '1.0';
      await AttendanceProfileModel.upsertConsent(userId, version);
      return res.status(200).json({
        success: true,
        message: 'Consent recorded successfully',
        data: {
          userId,
          consentAt: new Date().toISOString(),
          version,
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/attendance/challenge
   */
  async requestChallenge(req, res, next) {
    let userId = req.siteUser?.user_id;
    let accuracyVal = null;
    let ip = clientIp(req);
    try {
      await assertNotLocked(userId);
      const { lat, lng, accuracy } = assertLatLngAccuracy(req.body);
      accuracyVal = accuracy;

      const purpose = req.body?.purpose;
      if (!['checkin', 'reverify'].includes(purpose)) {
        throw httpError(400, "purpose must be either 'checkin' or 'reverify'.");
      }

      const { profile, office } = await loadProfileAndOffice(userId);
      requireConsent(profile, 'requesting a challenge');

      assertLocation(office, lat, lng, accuracy, ip);

      const challenge = await createChallenge({ userId, purpose });
      return res.status(200).json({
        success: true,
        message: 'Challenge issued',
        data: challenge,
      });
    } catch (err) {
      if (userId && err.status === 400) {
        await recordAttempt({
          userId,
          kind: 'challenge',
          success: false,
          accuracy: accuracyVal,
          ip,
          reason: err.attemptReason || err.message,
        }).catch(() => {});
      }
      next(err);
    }
  },

  /**
   * POST /api/attendance/check-in
   */
  async checkIn(req, res, next) {
    const userId = req.siteUser.user_id;
    let accuracyVal = null;
    const ip = clientIp(req);
    let attemptRecorded = false;

    try {
      await assertNotLocked(userId);
      const { lat, lng, accuracy } = assertLatLngAccuracy(req.body);
      accuracyVal = accuracy;

      const challengeId = req.body?.challengeId;
      if (!challengeId || typeof challengeId !== 'string') {
        throw httpError(400, 'challengeId is required.');
      }

      const descriptors = assertDescriptors(req.body?.descriptors, 3, 'descriptors');

      const { profile, office } = await loadProfileAndOffice(userId);
      requireConsent(profile, 'check-in');

      await loadAndValidateChallenge({ challengeId, userId, purpose: 'checkin' });

      // Atomically consume challenge
      const marked = await AttendanceChallengeModel.markUsed(challengeId, toUtcDateTime(new Date()));
      if (!marked) {
        throw httpError(400, 'Challenge has already been used.');
      }

      assertLocation(office, lat, lng, accuracy, ip);
      assertLivenessDescriptors(descriptors);

      const template = await loadTemplate(userId);
      const match = matchAll(descriptors, template);
      if (!match.ok) {
        attemptRecorded = true;
        await recordAttempt({
          userId,
          kind: 'checkin',
          success: false,
          distanceScore: match.distance,
          accuracy: accuracyVal,
          ip,
          reason: 'face_mismatch',
        });
        throw httpError(400, 'Face verification failed: descriptor distance above threshold.');
      }

      attemptRecorded = true;
      await recordAttempt({
        userId,
        kind: 'checkin',
        success: true,
        distanceScore: match.distance,
        accuracy: accuracyVal,
        ip,
        reason: null,
      });

      const record = await createCheckInRecord({
        user: req.siteUser,
        office,
        profile,
        lat,
        lng,
        accuracy,
        ip,
      });

      attendanceBus.emit('checkin', {
        employeeId: userId,
        name: req.siteUser.fullname,
        time: record.check_in_at,
      });

      return res.status(200).json({
        success: true,
        message: 'Check-in successful',
        data: record,
      });
    } catch (err) {
      if (!attemptRecorded && userId && (err.status === 400 || err.code === 'ER_DUP_ENTRY')) {
        await recordAttempt({
          userId,
          kind: 'checkin',
          success: false,
          distanceScore: err.distanceScore || null,
          accuracy: accuracyVal,
          ip,
          reason: err.attemptReason || err.message,
        }).catch(() => {});
      }
      next(err);
    }
  },

  /**
   * POST /api/attendance/heartbeat
   */
  async heartbeat(req, res, next) {
    try {
      const userId = req.siteUser.user_id;
      const { lat, lng, accuracy } = assertLatLngAccuracy(req.body);

      const record = await AttendanceRecordModel.findOpenByUser(userId);
      if (!record) {
        throw httpError(409, 'No open attendance record found for today.');
      }

      const office = await AttendanceOfficeModel.findById(record.office_id);
      if (!office) {
        throw httpError(400, 'Assigned office was not found.');
      }

      const L = Number(office.accuracy_max_m) || 50;
      const R = Number(office.radius_m) || 150;
      const cap = 4 * L;
      const d = haversineMetres(Number(lat), Number(lng), Number(office.lat), Number(office.lng));
      const a = Number(accuracy);

      const presence = await AttendancePresenceModel.findByRecordId(record.id);
      const currentWeakStreak = presence?.weak_streak || 0;
      const currentOutsideStreak = presence?.outside_streak || 0;

      let nextState = presence.state;
      let nextReason = presence.reason || null;
      let nextWeakStreak = currentWeakStreak;
      let nextOutsideStreak = currentOutsideStreak;
      let shouldRefreshLastInside = false;

      if (a > cap) {
        // a > cap: WEAK (proves nothing). Do not refresh last_inside_at; weak_streak += 1;
        // at weak_streak >= 3 set UNKNOWN with reason "weak_gps".
        nextWeakStreak = currentWeakStreak + 1;
        if (nextWeakStreak >= 3) {
          nextState = 'UNKNOWN';
          nextReason = 'weak_gps';
        }
      } else if (d + a <= R) {
        // else if d + a <= R: INSIDE proven. Refresh last_inside_at; reset weak_streak and outside_streak.
        nextWeakStreak = 0;
        nextOutsideStreak = 0;
        if (presence.state === 'OUTSIDE') {
          // Return flow: once outside, stays outside until /reverify passes
          nextState = 'OUTSIDE';
          nextReason = 'left';
          shouldRefreshLastInside = false;
        } else if (presence.state === 'UNKNOWN' && presence.left_alerted_at) {
          // UNKNOWN beyond tolerance: requires /reverify like the OUTSIDE case
          nextState = 'UNKNOWN';
          nextReason = presence.reason;
          shouldRefreshLastInside = false;
        } else {
          nextState = 'INSIDE';
          nextReason = null;
          shouldRefreshLastInside = true;
        }
      } else if (d - a > R) {
        // else if d - a > R: OUTSIDE proven (even if a > L). Apply the existing "return flow" and outside_streak logic; reset weak_streak.
        nextWeakStreak = 0;
        nextOutsideStreak = currentOutsideStreak + 1;
        nextState = 'OUTSIDE';
        nextReason = 'left';
      } else if (d <= R) {
        // else if d <= R: probably inside (uncertainty circle crosses the border). Treat as inside: refresh last_inside_at, reset weak_streak, do not increase outside_streak.
        nextWeakStreak = 0;
        if (presence.state === 'OUTSIDE') {
          nextState = 'OUTSIDE';
          nextReason = 'left';
          shouldRefreshLastInside = false;
        } else if (presence.state === 'UNKNOWN' && presence.left_alerted_at) {
          nextState = 'UNKNOWN';
          nextReason = presence.reason;
          shouldRefreshLastInside = false;
        } else {
          nextState = 'INSIDE';
          nextReason = null;
          shouldRefreshLastInside = true;
        }
      } else {
        // else (d > R but circle overlaps the office): ambiguous outside. outside_streak += 1; reset weak_streak; at outside_streak >= 2 set OUTSIDE.
        nextWeakStreak = 0;
        nextOutsideStreak = currentOutsideStreak + 1;
        if (presence.state === 'OUTSIDE') {
          nextState = 'OUTSIDE';
          nextReason = 'left';
        } else if (nextOutsideStreak >= 2) {
          nextState = 'OUTSIDE';
          nextReason = 'left';
        } else {
          nextState = presence.state;
        }
      }

      const now = new Date();
      const nowUtc = toUtcDateTime(now);

      if (nextState !== presence.state) {
        await applyPresenceTransition({
          recordId: record.id,
          userId,
          nextState,
          reason: nextReason,
          outsideStreak: nextOutsideStreak,
          weakStreak: nextWeakStreak,
          at: now,
          lat,
          lng,
          accuracy,
          expectedState: presence.state,
        });
      } else {
        await AttendancePresenceModel.updateConditional({
          recordId: record.id,
          expectedState: presence.state,
          state: nextState,
          reason: nextReason,
          outsideStreak: nextOutsideStreak,
          weakStreak: nextWeakStreak,
          at: nowUtc,
          lat,
          lng,
          accuracy,
          lastInsideAt: shouldRefreshLastInside ? nowUtc : presence.last_inside_at,
          outsideSince: nextState === 'OUTSIDE' ? (presence.outside_since || nowUtc) : null,
        });
      }

      const pendingTask = await AttendanceReverifyModel.pendingForRecord(record.id);
      const latestPresence = await AttendancePresenceModel.findByRecordId(record.id);

      return res.status(200).json({
        success: true,
        data: {
          state: latestPresence.state,
          reason: latestPresence.reason || null,
          reverifyPending: Boolean(pendingTask),
          reverifyDueAt: pendingTask?.due_at || null,
          lastHeartbeatAt: now.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/attendance/reverify
   */
  async reverify(req, res, next) {
    const userId = req.siteUser.user_id;
    let accuracyVal = null;
    const ip = clientIp(req);
    let attemptRecorded = false;

    try {
      await assertNotLocked(userId);
      const { lat, lng, accuracy } = assertLatLngAccuracy(req.body);
      accuracyVal = accuracy;

      const challengeId = req.body?.challengeId;
      if (!challengeId || typeof challengeId !== 'string') {
        throw httpError(400, 'challengeId is required.');
      }

      const descriptors = assertDescriptors(req.body?.descriptors, 3, 'descriptors');

      const { profile, office } = await loadProfileAndOffice(userId);
      requireConsent(profile, 're-verification');

      const record = await AttendanceRecordModel.findOpenByUser(userId);
      if (!record) {
        throw httpError(409, 'No open attendance record found for today.');
      }

      await loadAndValidateChallenge({ challengeId, userId, purpose: 'reverify' });

      // Atomically consume challenge
      const marked = await AttendanceChallengeModel.markUsed(challengeId, toUtcDateTime(new Date()));
      if (!marked) {
        throw httpError(400, 'Challenge has already been used.');
      }

      assertLocation(office, lat, lng, accuracy, ip);
      assertLivenessDescriptors(descriptors);

      const template = await loadTemplate(userId);
      const match = matchAll(descriptors, template);
      if (!match.ok) {
        attemptRecorded = true;
        await recordAttempt({
          userId,
          kind: 'reverify',
          success: false,
          distanceScore: match.distance,
          accuracy: accuracyVal,
          ip,
          reason: 'face_mismatch',
        });
        throw httpError(400, 'Face verification failed: descriptor distance above threshold.');
      }

      attemptRecorded = true;
      await recordAttempt({
        userId,
        kind: 'reverify',
        success: true,
        distanceScore: match.distance,
        accuracy: accuracyVal,
        ip,
        reason: null,
      });

      const now = new Date();
      const presence = await AttendancePresenceModel.findByRecordId(record.id);
      const wasOutside = presence?.state === 'OUTSIDE';

      if (presence?.state === 'OUTSIDE' || presence?.state === 'UNKNOWN') {
        await applyPresenceTransition({
          recordId: record.id,
          userId,
          nextState: 'INSIDE',
          reason: null,
          outsideStreak: 0,
          weakStreak: 0,
          at: now,
          lat,
          lng,
          accuracy,
        });
      }

      const pendingTask = await AttendanceReverifyModel.pendingForRecord(record.id);
      if (pendingTask) {
        await AttendanceReverifyModel.complete(pendingTask.id, toUtcDateTime(now));
      }

      if (wasOutside) {
        attendanceBus.emit('returned', {
          employeeId: userId,
          name: req.siteUser.fullname,
          time: toUtcDateTime(now),
        });
      }

      attendanceBus.emit('reverify', {
        employeeId: userId,
        name: req.siteUser.fullname,
        time: toUtcDateTime(now),
      });

      return res.status(200).json({
        success: true,
        message: 'Re-verification successful',
        data: {
          state: 'INSIDE',
          reverified: true,
        },
      });
    } catch (err) {
      if (!attemptRecorded && userId && err.status === 400) {
        await recordAttempt({
          userId,
          kind: 'reverify',
          success: false,
          distanceScore: err.distanceScore || null,
          accuracy: accuracyVal,
          ip,
          reason: err.attemptReason || err.message,
        }).catch(() => {});
      }
      next(err);
    }
  },

  /**
   * POST /api/attendance/check-out
   */
  async checkOut(req, res, next) {
    try {
      const userId = req.siteUser.user_id;
      const { lat, lng, accuracy } = assertLatLngAccuracy(req.body);

      const record = await AttendanceRecordModel.findOpenByUser(userId);
      if (!record) {
        throw httpError(409, 'No open attendance record found to check out.');
      }

      const now = new Date();
      const utc = toUtcDateTime(now);

      // Close open presence interval
      await AttendanceIntervalModel.closeOpen(record.id, utc);

      // Compute worked minutes via shared policy utility
      const office = await AttendanceOfficeModel.findById(record.office_id);
      const intervals = await AttendanceIntervalModel.findAllByRecord(record.id);
      const workedMinutes = computeWorkedMinutes({
        checkInAt: record.check_in_at,
        closeTime: utc,
        intervals,
        toleranceMinutes: office?.outside_tolerance_minutes || 10,
        allowanceMinutes: office?.short_outing_allowance_minutes || 30,
      });

      // Update record with checkout details and coordinates
      await AttendanceRecordModel.checkout(record.id, {
        checkOutAt: utc,
        workedMinutes,
        status: record.status,
        lat,
        lng,
        accuracy,
      });

      // Update presence
      const presence = await AttendancePresenceModel.findByRecordId(record.id);
      if (presence) {
        await AttendancePresenceModel.updateHeartbeat({
          recordId: record.id,
          state: presence.state,
          outsideStreak: presence.outside_streak,
          at: utc,
          lat,
          lng,
          accuracy,
          lastInsideAt: presence.last_inside_at,
          outsideSince: presence.outside_since,
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Check-out successful',
        data: {
          recordId: record.id,
          checkOutAt: now.toISOString(),
          workedMinutes,
          status: record.status,
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/attendance/me/history?month=YYYY-MM
   */
  async getHistory(req, res, next) {
    try {
      const userId = req.siteUser.user_id;
      const { year, month } = parseMonth(req.query.month || istCalendarDate(new Date()).slice(0, 7));
      const records = await AttendanceRecordModel.listByUserMonth(userId, year, month);
      return res.status(200).json({
        success: true,
        data: {
          month: `${year}-${String(month).padStart(2, '0')}`,
          records,
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/attendance/regularization
   */
  async requestRegularization(req, res, next) {
    try {
      const userId = req.siteUser.user_id;
      const date = parseIsoDate(req.body?.date, 'date');
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (!reason || reason.length > 500) {
        throw httpError(400, 'reason is required and must not exceed 500 characters.');
      }

      const id = await AttendanceRegularizationModel.create({
        userId,
        attendanceDate: date,
        reason,
      });

      return res.status(200).json({
        success: true,
        message: 'Regularization request submitted successfully',
        data: {
          id,
          date,
          status: 'PENDING',
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/attendance/admin/employees/:userId/face
   */
  async adminEnrolFace(req, res, next) {
    try {
      const userId = req.params.userId;
      const descriptors = assertDescriptors(req.body?.descriptors, 5, 'descriptors');

      const profile = await AttendanceProfileModel.findByUserId(userId);
      if (!profile?.consent_at) {
        throw httpError(403, 'Employee consent is required before face enrolment.');
      }

      // Check mean pairwise distance
      let totalDist = 0;
      let pairs = 0;
      for (let i = 0; i < 5; i += 1) {
        for (let j = i + 1; j < 5; j += 1) {
          totalDist += euclideanDistance(descriptors[i], descriptors[j]);
          pairs += 1;
        }
      }
      const meanDist = totalDist / pairs;
      if (meanDist > 0.6) {
        throw httpError(400, 'Face descriptors differ too much from each other. Ensure consistent lighting and posture.');
      }

      const template = averageDescriptors(descriptors);
      const encrypted = encryptEmbedding(template);
      await AttendanceProfileModel.upsertFace(userId, encrypted);

      await AttendanceAuditLogModel.log({
        actorAdminId: req.admin.id,
        action: 'enrol_face',
        entityType: 'employee',
        entityId: userId,
        afterJson: { enrolled_at: new Date().toISOString() },
      });

      return res.status(200).json({
        success: true,
        message: 'Face template enrolled successfully',
        data: {
          userId,
          enrolledAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * DELETE /api/attendance/admin/employees/:userId/face
   */
  async adminDeleteFace(req, res, next) {
    try {
      const userId = req.params.userId;
      await AttendanceProfileModel.clearFace(userId);

      await AttendanceAuditLogModel.log({
        actorAdminId: req.admin.id,
        action: 'delete_face',
        entityType: 'employee',
        entityId: userId,
      });

      return res.status(200).json({
        success: true,
        message: 'Face template deleted successfully',
        data: { userId },
      });
    } catch (err) {
      next(err);
    }
  },
};

module.exports = AttendanceController;
