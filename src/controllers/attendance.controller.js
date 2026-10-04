const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const {
  httpError,
  finiteNumber,
  assertLatLngAccuracy,
  assertDescriptors,
  clientIp,
  parseMonth,
  parseIsoDate,
  validateOfficeInput,
} = require('../utils/attendanceValidate');
const { haversineMetres } = require('../utils/geo');
const { encryptEmbedding } = require('../utils/crypto');
const {
  euclideanDistance,
  averageDescriptors,
  minPairwiseDistance,
  replayEpsilon,
} = require('../utils/faceMath');
const { toUtcDateTime, fromUtcDateTime, istCalendarDate, istDateTimeToUtc, sqlUtc } = require('../utils/time');
const { computeWorkedMinutes } = require('../utils/workedMinutes');
const { toCsv } = require('../utils/csv');
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
const AttendanceLeaveModel = require('../models/attendanceLeave.model');
const AttendanceAttemptModel = require('../models/attendanceAttempt.model');
const SiteUserModel = require('../models/siteUser.model');

// Map of adminId -> number of active SSE streams
const activeAdminStreams = new Map();

const AttendanceController = {
  // Injectable ping interval for testing
  ssePingIntervalMs: 25000,
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

      let reverifyRequired = false;
      if (presence && office && presence.last_lat != null && presence.last_lng != null) {
        const isOutsideOrAlertedUnknown =
          presence.state === 'OUTSIDE' || (presence.state === 'UNKNOWN' && Boolean(presence.left_alerted_at));
        if (isOutsideOrAlertedUnknown) {
          const d = haversineMetres(Number(office.lat), Number(office.lng), Number(presence.last_lat), Number(presence.last_lng));
          const a = Number(presence.last_accuracy) || 0;
          const R = Number(office.radius_m);
          const L = Number(office.accuracy_max_m) || 50;
          const cap = 4 * L;
          reverifyRequired = a <= cap && d <= R;
        }
      }

      return res.status(200).json({
        success: true,
        data: {
          office: officePublicSubset(office),
          faceEnrolled,
          consentGiven,
          consentAt: profile.consent_at,
          todayRecord,
          presenceState: presence ? presence.state : null,
          reverifyRequired,
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
        // weak_streak -> UNKNOWN applies only when the current state is INSIDE.
        // A weak reading must never change state when OUTSIDE (keep OUTSIDE/"left");
        // Keep UNKNOWN as UNKNOWN.
        nextWeakStreak = currentWeakStreak + 1;
        if (presence.state === 'INSIDE') {
          if (nextWeakStreak >= 3) {
            nextState = 'UNKNOWN';
            nextReason = 'weak_gps';
          }
        } else if (presence.state === 'OUTSIDE') {
          nextState = 'OUTSIDE';
          nextReason = 'left';
        } else if (presence.state === 'UNKNOWN') {
          nextState = 'UNKNOWN';
          nextReason = presence.reason;
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

      let writeSuccess = true;
      if (nextState !== presence.state) {
        const transRes = await applyPresenceTransition({
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
        writeSuccess = transRes.success !== false;
      } else {
        writeSuccess = await AttendancePresenceModel.updateConditional({
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

      // Re-read latest presence from DB (if conditional write affected 0 rows, latestPresence has the current concurrent state)
      const latestPresence = await AttendancePresenceModel.findByRecordId(record.id);
      const pendingTask = await AttendanceReverifyModel.pendingForRecord(record.id);

      const finalState = latestPresence ? latestPresence.state : nextState;
      const finalReason = latestPresence ? latestPresence.reason : nextReason;
      const finalLeftAlertedAt = latestPresence ? latestPresence.left_alerted_at : presence.left_alerted_at;

      // reverifyRequired: true when presence.state is OUTSIDE, or UNKNOWN with left_alerted_at set,
      // AND the latest reading was proven-inside or probably-inside (d <= R, not weak: a <= cap).
      const isOutsideOrAlertedUnknown =
        finalState === 'OUTSIDE' || (finalState === 'UNKNOWN' && Boolean(finalLeftAlertedAt));
      const isInsideReading = a <= cap && d <= R;
      const reverifyRequired = Boolean(isOutsideOrAlertedUnknown && isInsideReading);

      return res.status(200).json({
        success: true,
        data: {
          state: finalState,
          reason: finalReason || null,
          reverifyRequired,
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

  // ── Offices CRUD ──────────────────────────────────────────────────────────

  /**
   * POST /api/attendance/admin/offices
   */
  async adminCreateOffice(req, res, next) {
    try {
      const data = validateOfficeInput(req.body, false);
      const id = await AttendanceOfficeModel.create(data);
      const office = await AttendanceOfficeModel.findById(id);

      await AttendanceAuditLogModel.log({
        actorAdminId: req.admin.id,
        action: 'office_create',
        entityType: 'office',
        entityId: id,
        afterJson: office,
      });

      return res.status(201).json({
        success: true,
        message: 'Office created successfully',
        data: { office },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/attendance/admin/offices
   */
  async adminGetOffices(req, res, next) {
    try {
      const offices = await AttendanceOfficeModel.findAll();
      return res.status(200).json({
        success: true,
        data: { offices },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/attendance/admin/offices/:id
   */
  async adminGetOfficeById(req, res, next) {
    try {
      const office = await AttendanceOfficeModel.findById(req.params.id);
      if (!office) throw httpError(404, 'Office not found.');
      return res.status(200).json({
        success: true,
        data: { office },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * PUT /api/attendance/admin/offices/:id
   */
  async adminUpdateOffice(req, res, next) {
    try {
      const id = req.params.id;
      const existing = await AttendanceOfficeModel.findById(id);
      if (!existing) throw httpError(404, 'Office not found.');

      const data = validateOfficeInput(req.body, true);
      await AttendanceOfficeModel.update(id, data);
      const updated = await AttendanceOfficeModel.findById(id);

      await AttendanceAuditLogModel.log({
        actorAdminId: req.admin.id,
        action: 'office_update',
        entityType: 'office',
        entityId: id,
        beforeJson: existing,
        afterJson: updated,
      });

      return res.status(200).json({
        success: true,
        message: 'Office updated successfully',
        data: { office: updated },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * DELETE /api/attendance/admin/offices/:id
   */
  async adminDeleteOffice(req, res, next) {
    try {
      const id = req.params.id;
      const existing = await AttendanceOfficeModel.findById(id);
      if (!existing) throw httpError(404, 'Office not found.');

      const refs = await AttendanceOfficeModel.countReferences(id);
      if (refs.total > 0) {
        throw httpError(409, 'Cannot delete office: referenced by employee profiles or attendance records.');
      }

      await AttendanceOfficeModel.delete(id);
      await AttendanceAuditLogModel.log({
        actorAdminId: req.admin.id,
        action: 'office_delete',
        entityType: 'office',
        entityId: id,
        beforeJson: existing,
      });

      return res.status(200).json({
        success: true,
        message: 'Office deleted successfully',
      });
    } catch (err) {
      next(err);
    }
  },

  // ── Employees & Profile ───────────────────────────────────────────────────

  /**
   * GET /api/attendance/admin/employees
   */
  async adminGetEmployees(req, res, next) {
    try {
      const employees = await AttendanceProfileModel.listAllEmployees();
      return res.status(200).json({
        success: true,
        data: { employees },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * PUT /api/attendance/admin/employees/:userId/profile
   */
  async adminUpdateEmployeeProfile(req, res, next) {
    try {
      const userId = req.params.userId;
      const siteUser = await SiteUserModel.findById(userId);
      if (!siteUser) throw httpError(404, 'Site user not found.');

      const existing = await AttendanceProfileModel.findByUserId(userId);
      const { officeId, shiftStart, shiftEnd, department, designation } = req.body || {};

      if (officeId) {
        const office = await AttendanceOfficeModel.findById(officeId);
        if (!office) throw httpError(400, 'Office does not exist.');
      }

      const updated = await AttendanceProfileModel.upsertProfile(userId, {
        officeId,
        shiftStart,
        shiftEnd,
        department,
        designation,
      });

      await AttendanceAuditLogModel.log({
        actorAdminId: req.admin.id,
        action: 'profile_update',
        entityType: 'profile',
        entityId: userId,
        beforeJson: existing,
        afterJson: updated,
      });

      return res.status(200).json({
        success: true,
        message: 'Profile updated successfully',
        data: { profile: updated },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/attendance/admin/employees/:userId/timeline?date=YYYY-MM-DD
   */
  async adminGetTimeline(req, res, next) {
    try {
      const userId = req.params.userId;
      const date = req.query.date ? parseIsoDate(req.query.date, 'date') : istCalendarDate(new Date());

      const siteUser = await SiteUserModel.findById(userId);
      if (!siteUser) throw httpError(404, 'Site user not found.');

      const record = await AttendanceRecordModel.findByUserDate(userId, date);
      if (!record) {
        return res.status(200).json({
          success: true,
          data: {
            date,
            record: null,
            intervals: [],
            attempts: [],
            presenceState: null,
            lastKnownPoint: null,
            workedMinutes: 0,
          },
        });
      }

      const intervals = await AttendanceIntervalModel.findAllByRecord(record.id);
      const presence = await AttendancePresenceModel.findByRecordId(record.id);
      const attemptsResult = await AttendanceAttemptModel.findAll({ userId, date, limit: 100 });

      const isOpen = record.check_in_at != null && record.check_out_at == null;
      const lastKnownPoint =
        isOpen && presence && presence.last_lat != null && presence.last_lng != null
          ? {
              lat: presence.last_lat,
              lng: presence.last_lng,
              accuracy: presence.last_accuracy,
              at: presence.last_heartbeat_at,
            }
          : null;

      const profile = await AttendanceProfileModel.findByUserId(userId);
      const office = profile?.office_id ? await AttendanceOfficeModel.findById(profile.office_id) : null;

      const workedMinutes = isOpen
        ? computeWorkedMinutes({
            checkInAt: record.check_in_at,
            closeTime: new Date(),
            intervals,
            toleranceMinutes: office?.outside_tolerance_minutes || 10,
            allowanceMinutes: office?.short_outing_allowance_minutes || 30,
          })
        : record.worked_minutes;

      return res.status(200).json({
        success: true,
        data: {
          date,
          record,
          intervals,
          attempts: attemptsResult.rows,
          presenceState: presence?.state || (record.check_out_at ? 'CHECKED_OUT' : null),
          lastKnownPoint,
          workedMinutes,
        },
      });
    } catch (err) {
      next(err);
    }
  },

  // ── Live Snapshot & SSE Stream ────────────────────────────────────────────

  /**
   * GET /api/attendance/admin/live
   * Exactly 1-2 queries (no N+1): Query 1 joins users, profiles, records, presence, leaves;
   * Query 2 fetches open intervals for worked minutes computation.
   */
  async adminGetLive(req, res, next) {
    try {
      const today = istCalendarDate(new Date());

      // Query 1: Active Attendance employees + today's record + presence + approved leave
      const [rows] = await pool.query(
        `SELECT
           u.user_id AS employee_id,
           u.fullname,
           prof.department,
           r.id AS record_id,
           ${sqlUtc('r.check_in_at', 'check_in_at')},
           ${sqlUtc('r.check_out_at', 'check_out_at')},
           r.status AS record_status,
           r.worked_minutes AS stored_worked_minutes,
           p.state AS presence_state,
           p.reason AS presence_reason,
           ${sqlUtc('p.last_heartbeat_at', 'last_heartbeat_at')},
           ${sqlUtc('p.outside_since', 'outside_since')},
           ${sqlUtc('p.last_inside_at', 'last_inside_at')},
           p.left_alerted_at,
           o.outside_tolerance_minutes,
           o.short_outing_allowance_minutes,
           l.id AS leave_id,
           l.reason AS leave_reason,
           (
             SELECT id FROM attendance_reverify_tasks
             WHERE record_id = r.id AND status = 'PENDING'
             LIMIT 1
           ) AS pending_reverify_id
         FROM site_users u
         LEFT JOIN attendance_profiles prof ON prof.user_id = u.user_id COLLATE utf8mb4_unicode_ci
         LEFT JOIN attendance_offices o ON o.id = prof.office_id
         LEFT JOIN attendance_records r ON r.user_id = u.user_id COLLATE utf8mb4_unicode_ci AND r.attendance_date = ?
         LEFT JOIN attendance_presence p ON p.record_id = r.id
         LEFT JOIN attendance_leaves l ON l.user_id = u.user_id COLLATE utf8mb4_unicode_ci AND l.leave_date = ? AND l.status = 'APPROVED'
         WHERE u.is_active = 1
           AND JSON_CONTAINS(u.module_access, '"Attendance"')
         ORDER BY u.fullname ASC`,
        [today, today]
      );

      // Collect open record IDs for Query 2
      const openRecordIds = rows
        .filter((r) => r.record_id && r.check_in_at && !r.check_out_at)
        .map((r) => r.record_id);

      const intervalsByRecord = {};
      if (openRecordIds.length > 0) {
        // Query 2: All intervals for open records
        const [intervals] = await pool.query(
          `SELECT record_id, state, ${sqlUtc('started_at', 'started_at')}, ${sqlUtc('ended_at', 'ended_at')}
           FROM attendance_intervals
           WHERE record_id IN (?)
           ORDER BY started_at ASC`,
          [openRecordIds]
        );
        for (const intv of intervals) {
          if (!intervalsByRecord[intv.record_id]) intervalsByRecord[intv.record_id] = [];
          intervalsByRecord[intv.record_id].push(intv);
        }
      }

      const now = new Date();
      let presentCount = 0;
      let lateCount = 0;
      let insideCount = 0;
      let outsideCount = 0;
      let noSignalCount = 0;
      let absentCount = 0;
      let onLeaveCount = 0;

      const employeeRows = rows.map((r) => {
        const isOpen = Boolean(r.record_id && r.check_in_at && !r.check_out_at);
        const hasRecord = Boolean(r.record_id);
        const isOnLeave = Boolean(r.leave_id);

        if (hasRecord) {
          presentCount += 1;
          if (r.record_status === 'LATE') lateCount += 1;
        }

        if (isOpen) {
          if (r.presence_state === 'INSIDE') insideCount += 1;
          else if (r.presence_state === 'OUTSIDE') outsideCount += 1;
          else if (r.presence_state === 'UNKNOWN') noSignalCount += 1;
        } else if (isOnLeave) {
          onLeaveCount += 1;
        } else if (!hasRecord) {
          absentCount += 1;
        }

        let workedMinutes = 0;
        if (isOpen) {
          workedMinutes = computeWorkedMinutes({
            checkInAt: r.check_in_at,
            closeTime: now,
            intervals: intervalsByRecord[r.record_id] || [],
            toleranceMinutes: r.outside_tolerance_minutes || 10,
            allowanceMinutes: r.short_outing_allowance_minutes || 30,
          });
        } else if (hasRecord) {
          workedMinutes = Number(r.stored_worked_minutes) || 0;
        }

        let since = null;
        if (r.presence_state === 'OUTSIDE') since = r.outside_since || r.last_heartbeat_at;
        else if (r.presence_state === 'UNKNOWN') since = r.last_inside_at || r.last_heartbeat_at;
        else if (r.presence_state === 'INSIDE') since = r.last_inside_at || r.check_in_at;
        else if (r.check_out_at) since = r.check_out_at;

        let status = 'ABSENT';
        if (hasRecord) status = r.record_status;
        else if (isOnLeave) status = 'LEAVE';

        let presenceState = 'ABSENT';
        if (isOpen) presenceState = r.presence_state;
        else if (hasRecord && r.check_out_at) presenceState = 'CHECKED_OUT';
        else if (isOnLeave) presenceState = 'LEAVE';

        return {
          employeeId: r.employee_id,
          name: r.fullname,
          department: r.department,
          checkInTime: r.check_in_at || null,
          status,
          presenceState,
          reason: r.presence_reason || (isOnLeave ? r.leave_reason : null),
          since: since || null,
          workedMinutes,
          reverifyPending: Boolean(r.pending_reverify_id),
        };
      });

      return res.status(200).json({
        success: true,
        data: {
          date: today,
          counts: {
            present: presentCount,
            late: lateCount,
            inside: insideCount,
            outside: outsideCount,
            no_signal: noSignalCount,
            absent: absentCount,
            on_leave: onLeaveCount,
          },
          rows: employeeRows,
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/attendance/admin/stream (SSE)
   */
  async adminGetStream(req, res, next) {
    try {
      const adminId = req.admin.id;
      const currentActive = activeAdminStreams.get(adminId) || 0;
      if (currentActive >= 5) {
        return res.status(429).json({
          success: false,
          message: 'Too many concurrent stream connections (max 5 per admin).',
        });
      }
      activeAdminStreams.set(adminId, currentActive + 1);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Send initial comment
      res.write(': connected\n\n');

      // Schedule stream closure on JWT expiration
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      const decoded = jwt.decode(token);
      let expiryTimer = null;
      if (decoded?.exp) {
        const msUntilExpiry = decoded.exp * 1000 - Date.now();
        if (msUntilExpiry <= 0) {
          activeAdminStreams.set(adminId, Math.max(0, (activeAdminStreams.get(adminId) || 1) - 1));
          return res.status(401).end();
        }
        expiryTimer = setTimeout(() => {
          res.end();
        }, msUntilExpiry);
      }

      // Comment ping every 25 seconds (injectable for tests)
      const pingMs = AttendanceController.ssePingIntervalMs || 25000;
      const pingTimer = setInterval(() => {
        res.write(': ping\n\n');
      }, pingMs);

      // Subscribe to attendanceBus
      const unsubscribe = attendanceBus.subscribe((evt) => {
        if (['checkin', 'reverify', 'left_premises', 'returned', 'auto_checkout', 'violation'].includes(evt.type)) {
          const payload = {
            employeeId: evt.employeeId,
            name: evt.name,
            type: evt.type,
            time: evt.time instanceof Date ? evt.time.toISOString() : evt.time || new Date().toISOString(),
            reason: evt.reason || null,
          };
          res.write(`event: ${evt.type}\ndata: ${JSON.stringify(payload)}\n\n`);
        }
      });

      req.on('close', () => {
        unsubscribe();
        clearInterval(pingTimer);
        if (expiryTimer) clearTimeout(expiryTimer);
        activeAdminStreams.set(adminId, Math.max(0, (activeAdminStreams.get(adminId) || 1) - 1));
      });
    } catch (err) {
      next(err);
    }
  },

  // ── Reports & Attempts ───────────────────────────────────────────────────

  /**
   * GET /api/attendance/admin/report?month=YYYY-MM&format=json|csv
   */
  async adminGetReport(req, res, next) {
    try {
      const monthStr = req.query.month;
      if (!monthStr || !/^\d{4}-\d{2}$/.test(String(monthStr))) {
        throw httpError(400, 'month must be YYYY-MM.');
      }
      const format = (req.query.format || 'json').toLowerCase();

      // Aggregate in SQL (no per-employee loop)
      const [rows] = await pool.query(
        `SELECT
           u.user_id,
           u.fullname,
           prof.department,
           COUNT(DISTINCT r.attendance_date) AS days_present,
           SUM(CASE WHEN r.status = 'LATE' THEN 1 ELSE 0 END) AS days_late,
           SUM(COALESCE(r.worked_minutes, 0)) AS total_worked_minutes,
           (
             SELECT COUNT(DISTINCT l.leave_date)
             FROM attendance_leaves l
             WHERE l.user_id = u.user_id COLLATE utf8mb4_unicode_ci
               AND DATE_FORMAT(l.leave_date, '%Y-%m') = ?
               AND l.status = 'APPROVED'
           ) AS days_leave
         FROM site_users u
         LEFT JOIN attendance_profiles prof ON prof.user_id = u.user_id COLLATE utf8mb4_unicode_ci
         LEFT JOIN attendance_records r
           ON r.user_id = u.user_id COLLATE utf8mb4_unicode_ci
           AND DATE_FORMAT(r.attendance_date, '%Y-%m') = ?
         WHERE u.is_active = 1
           AND JSON_CONTAINS(u.module_access, '"Attendance"')
         GROUP BY u.user_id, u.fullname, prof.department
         ORDER BY u.fullname ASC`,
        [monthStr, monthStr]
      );

      const reportRows = rows.map((r) => {
        const present = Number(r.days_present) || 0;
        const late = Number(r.days_late) || 0;
        const leave = Number(r.days_leave) || 0;
        const workedMinutes = Number(r.total_worked_minutes) || 0;
        const expectedMinutes = present * 480;
        const deductedMinutes = Math.max(0, expectedMinutes - workedMinutes);

        return {
          user_id: r.user_id,
          fullname: r.fullname,
          department: r.department || '',
          days_present: present,
          days_late: late,
          days_leave: leave,
          days_absent: Math.max(0, 22 - present - leave),
          total_worked_minutes: workedMinutes,
          total_deducted_minutes: deductedMinutes,
        };
      });

      if (format === 'csv') {
        const csvStr = toCsv(reportRows, [
          { key: 'user_id', label: 'Employee ID' },
          { key: 'fullname', label: 'Name' },
          { key: 'department', label: 'Department' },
          { key: 'days_present', label: 'Days Present' },
          { key: 'days_late', label: 'Days Late' },
          { key: 'days_leave', label: 'Days Leave' },
          { key: 'days_absent', label: 'Days Absent' },
          { key: 'total_worked_minutes', label: 'Total Worked Minutes' },
          { key: 'total_deducted_minutes', label: 'Total Deducted Minutes' },
        ]);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="attendance-report-${monthStr}.csv"`);
        return res.status(200).send(csvStr);
      }

      return res.status(200).json({
        success: true,
        data: {
          month: monthStr,
          report: reportRows,
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/attendance/admin/attempts
   */
  async adminGetAttempts(req, res, next) {
    try {
      const { user, date, success, limit, offset } = req.query;
      const result = await AttendanceAttemptModel.findAll({
        userId: user,
        date,
        success,
        limit,
        offset,
      });
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  },

  // ── Regularizations & Records ────────────────────────────────────────────

  /**
   * GET /api/attendance/admin/regularizations
   */
  async adminGetRegularizations(req, res, next) {
    try {
      const { status, limit, offset } = req.query;
      const requests = await AttendanceRegularizationModel.findAll({ status, limit, offset });
      return res.status(200).json({
        success: true,
        data: { regularizations: requests },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/attendance/admin/regularizations/:id/approve
   */
  async adminApproveRegularization(req, res, next) {
    try {
      const id = req.params.id;
      const reg = await AttendanceRegularizationModel.findById(id);
      if (!reg) throw httpError(404, 'Regularization request not found.');
      if (reg.status !== 'PENDING') {
        throw httpError(409, 'Only PENDING regularization requests can be approved.');
      }

      const { checkInTime, checkOutTime, status } = req.body || {};
      if (!checkInTime || !/^\d{2}:\d{2}(:\d{2})?$/.test(String(checkInTime))) {
        throw httpError(400, 'checkInTime is required as HH:mm.');
      }
      if (!checkOutTime || !/^\d{2}:\d{2}(:\d{2})?$/.test(String(checkOutTime))) {
        throw httpError(400, 'checkOutTime is required as HH:mm.');
      }
      if (!status || !['PRESENT', 'LATE'].includes(status)) {
        throw httpError(400, 'status must be PRESENT or LATE.');
      }

      const inDate = istDateTimeToUtc(reg.attendance_date, checkInTime);
      const outDate = istDateTimeToUtc(reg.attendance_date, checkOutTime);
      if (outDate <= inDate) {
        throw httpError(400, 'checkOutTime must be after checkInTime.');
      }

      const workedMinutes = Math.round((outDate.getTime() - inDate.getTime()) / 60000);
      const checkInUtc = toUtcDateTime(inDate);
      const checkOutUtc = toUtcDateTime(outDate);

      const profile = await AttendanceProfileModel.findByUserId(reg.user_id);
      const upsertResult = await AttendanceRecordModel.upsertForRegularization({
        userId: reg.user_id,
        attendanceDate: reg.attendance_date,
        fullname: reg.fullname || 'Employee',
        officeId: profile?.office_id || 1,
        checkInAt: checkInUtc,
        checkOutAt: checkOutUtc,
        status,
        workedMinutes,
      });

      await AttendanceRegularizationModel.updateStatus(id, {
        status: 'APPROVED',
        reviewedBy: req.admin.id,
      });

      await AttendanceAuditLogModel.log({
        actorAdminId: req.admin.id,
        action: 'regularization_approve',
        entityType: 'regularization',
        entityId: id,
        beforeJson: reg,
        afterJson: {
          ...reg,
          status: 'APPROVED',
          check_in_at: checkInUtc,
          check_out_at: checkOutUtc,
          worked_minutes: workedMinutes,
        },
      });

      return res.status(200).json({
        success: true,
        message: 'Regularization approved and attendance record updated',
        data: { record: upsertResult.record },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/attendance/admin/regularizations/:id/reject
   */
  async adminRejectRegularization(req, res, next) {
    try {
      const id = req.params.id;
      const reg = await AttendanceRegularizationModel.findById(id);
      if (!reg) throw httpError(404, 'Regularization request not found.');
      if (reg.status !== 'PENDING') {
        throw httpError(409, 'Only PENDING regularization requests can be rejected.');
      }

      await AttendanceRegularizationModel.updateStatus(id, {
        status: 'REJECTED',
        reviewedBy: req.admin.id,
      });

      await AttendanceAuditLogModel.log({
        actorAdminId: req.admin.id,
        action: 'regularization_reject',
        entityType: 'regularization',
        entityId: id,
        beforeJson: reg,
        afterJson: { ...reg, status: 'REJECTED' },
      });

      return res.status(200).json({
        success: true,
        message: 'Regularization rejected successfully',
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * PATCH /api/attendance/admin/records/:id
   */
  async adminPatchRecord(req, res, next) {
    try {
      const id = req.params.id;
      const existing = await AttendanceRecordModel.findById(id);
      if (!existing) throw httpError(404, 'Attendance record not found.');

      const { check_in_at, check_out_at, status, reason } = req.body || {};
      if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
        throw httpError(400, 'A reason of at least 10 characters is required for manual record adjustments.');
      }

      // Allow only check_in_at, check_out_at, status
      const newCheckIn = check_in_at ? toUtcDateTime(check_in_at) : existing.check_in_at;
      const newCheckOut = check_out_at ? toUtcDateTime(check_out_at) : existing.check_out_at;

      let workedMinutes = existing.worked_minutes;
      if (newCheckIn && newCheckOut) {
        const inDate = fromUtcDateTime(newCheckIn);
        const outDate = fromUtcDateTime(newCheckOut);
        if (outDate <= inDate) {
          throw httpError(400, 'check_out_at must be after check_in_at.');
        }
        if (
          istCalendarDate(inDate) !== existing.attendance_date ||
          istCalendarDate(outDate) !== existing.attendance_date
        ) {
          throw httpError(400, 'Both check_in_at and check_out_at must be on the same IST date as attendance_date.');
        }
        workedMinutes = Math.round((outDate.getTime() - inDate.getTime()) / 60000);
      }

      await AttendanceRecordModel.updateRecordAdmin(id, {
        checkInAt: newCheckIn,
        checkOutAt: newCheckOut,
        status: status || existing.status,
        workedMinutes,
      });

      const updated = await AttendanceRecordModel.findById(id);

      await AttendanceAuditLogModel.log({
        actorAdminId: req.admin.id,
        action: 'record_patch',
        entityType: 'record',
        entityId: id,
        beforeJson: existing,
        afterJson: { ...updated, reason: reason.trim() },
      });

      return res.status(200).json({
        success: true,
        message: 'Attendance record updated successfully',
        data: { record: updated },
      });
    } catch (err) {
      next(err);
    }
  },

  // ── Leaves ───────────────────────────────────────────────────────────────

  /**
   * POST /api/attendance/admin/leaves
   */
  async adminCreateLeave(req, res, next) {
    try {
      const { userId, fromDate, toDate, reason } = req.body || {};
      if (!userId || typeof userId !== 'string') throw httpError(400, 'userId is required.');

      const siteUser = await SiteUserModel.findById(userId);
      if (!siteUser) throw httpError(404, 'Site user not found.');

      const modules = Array.isArray(siteUser.moduleAccess)
        ? siteUser.moduleAccess
        : (Array.isArray(siteUser.module_access)
            ? siteUser.module_access
            : JSON.parse(siteUser.module_access || '[]'));
      if (!modules.includes('Attendance')) {
        throw httpError(400, 'User does not have access to the Attendance module.');
      }

      const from = parseIsoDate(fromDate, 'fromDate');
      const to = parseIsoDate(toDate, 'toDate');
      if (from > to) throw httpError(400, 'fromDate must be before or equal to toDate.');

      // Check overlapping approved leaves
      const overlap = await AttendanceLeaveModel.findOverlapping(userId, from, to);
      if (overlap.length > 0) {
        throw httpError(409, 'Leave already approved for one or more dates in this period.');
      }

      const result = await AttendanceLeaveModel.createApprovedSpan({
        userId,
        fromDate: from,
        toDate: to,
        reason: reason || 'Approved Leave',
        reviewedBy: req.admin.id,
      });

      await AttendanceAuditLogModel.log({
        actorAdminId: req.admin.id,
        action: 'leave_create',
        entityType: 'leave',
        entityId: userId,
        afterJson: { userId, fromDate: from, toDate: to, reason, count: result.count },
      });

      return res.status(201).json({
        success: true,
        message: 'Leave approved successfully',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/attendance/admin/leaves
   */
  async adminGetLeaves(req, res, next) {
    try {
      const { user, month, status, limit, offset } = req.query;
      const leaves = await AttendanceLeaveModel.findAll({
        userId: user,
        month,
        status,
        limit,
        offset,
      });
      return res.status(200).json({
        success: true,
        data: { leaves },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * PATCH or DELETE /api/attendance/admin/leaves/:id
   */
  async adminCancelLeave(req, res, next) {
    try {
      const id = req.params.id;
      const existing = await AttendanceLeaveModel.findById(id);
      if (!existing) throw httpError(404, 'Leave record not found.');

      await AttendanceLeaveModel.cancelLeave(id, req.admin.id);

      await AttendanceAuditLogModel.log({
        actorAdminId: req.admin.id,
        action: 'leave_cancel',
        entityType: 'leave',
        entityId: id,
        beforeJson: existing,
        afterJson: { ...existing, status: 'REJECTED' },
      });

      return res.status(200).json({
        success: true,
        message: 'Leave cancelled successfully',
      });
    } catch (err) {
      next(err);
    }
  },
};

module.exports = AttendanceController;
