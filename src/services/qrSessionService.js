const crypto = require('crypto');
const { pool } = require('../config/db');
const AttendanceQrSessionModel = require('../models/attendanceQrSession.model');
const AttendanceAuditLogModel = require('../models/attendanceAuditLog.model');
const { toUtcDateTime, fromUtcDateTime, istCalendarDate } = require('../utils/time');

/**
 * Hash a raw opaque QR token using SHA-256.
 * @param {string} rawToken
 * @returns {string} Hex-encoded SHA-256 hash (64 chars)
 */
function hashToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new Error('rawToken must be a non-empty string');
  }
  return crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
}

/**
 * Generate a cryptographically secure random opaque token.
 * 32 bytes hex = 64 hex characters (256 bits of entropy).
 * @returns {string}
 */
function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Derive or load the 32-byte AES-256-GCM encryption key from environment.
 * Never committed and never stored in the database.
 * @returns {Buffer} 32-byte key
 */
function getEncryptionKey() {
  const envKey = process.env.QR_ENC_KEY;
  if (envKey) {
    if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
      return Buffer.from(envKey, 'hex');
    }
    if (Buffer.byteLength(envKey, 'utf8') === 32) {
      return Buffer.from(envKey, 'utf8');
    }
    throw new Error('QR_ENC_KEY must be a 32-byte key (64 hex characters or 32 raw bytes).');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('QR_ENC_KEY environment variable is strictly required in production.');
  }
  // Safe local development / testing fallback derived from JWT_SECRET
  return crypto
    .createHash('sha256')
    .update(process.env.JWT_SECRET || 'tbs_default_dev_qr_encryption_key_256')
    .digest();
}

/**
 * Encrypt a raw QR token using authenticated AES-256-GCM.
 * Output format: ivHex:authTagHex:ciphertextHex
 * @param {string} rawToken
 * @returns {string}
 */
function encryptToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // Standard 96-bit IV for AES-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(rawToken).trim(), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt an AES-256-GCM encrypted token.
 * Validates authentication tag to ensure payload integrity.
 * @param {string} encryptedStr
 * @returns {string|null}
 */
function decryptToken(encryptedStr) {
  if (!encryptedStr || typeof encryptedStr !== 'string') return null;
  const parts = encryptedStr.split(':');
  if (parts.length !== 3) return null;
  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const cipherText = Buffer.from(parts[2], 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (_) {
    return null;
  }
}

const QrSessionService = {
  hashToken,
  generateRawToken,
  getEncryptionKey,
  encryptToken,
  decryptToken,

  /**
   * Retrieve currently active QR session with decrypted raw token for office, date, action.
   * Accessible only to authorized administrators (e.g. for page refresh recovery).
   */
  async getActiveSession({ officeId = 1, action, attendanceDate = null }) {
    if (!['CHECK_IN', 'CHECK_OUT'].includes(action)) {
      throw new Error(`Invalid action "${action}". Expected CHECK_IN or CHECK_OUT.`);
    }

    const date = attendanceDate || istCalendarDate();
    const session = await AttendanceQrSessionModel.findActive({
      officeId: Number(officeId) || 1,
      attendanceDate: date,
      action,
    });

    if (!session) {
      return { active: false, message: `No active QR session for ${action} on ${date}.` };
    }

    const expiresAtMs = fromUtcDateTime(session.expires_at)?.getTime() || 0;
    const nowMs = Date.now();

    if (expiresAtMs <= nowMs) {
      // Lazily mark expired
      await AttendanceQrSessionModel.expire(null, session.id);
      return { active: false, expiredSessionId: session.id, message: 'QR session has expired.' };
    }

    const secondsRemaining = Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000));
    const qrToken = decryptToken(session.encrypted_token);

    return {
      active: true,
      sessionId: session.id,
      qrToken,
      action: session.action,
      attendanceDate: session.attendance_date,
      officeId: session.office_id,
      expiresAt: session.expires_at,
      secondsRemaining,
      generationSeq: session.generation_seq,
    };
  },

  /**
   * Generate a QR session or idempotently retrieve active session for the day.
   *
   * Enforces:
   * 1. Single generation per day per (office, date, action).
   * 2. Idempotent retrieval when a valid session is already active (returns decrypted token).
   * 3. Requires explicit audited rotation flag (`allowRotation: true`) and reason if already generated today.
   * 4. Concurrency-safe against race conditions via DB unique constraint `uq_qr_active_slot`.
   */
  async getOrCreateSession({
    adminId,
    action,
    officeId = 1,
    validityMinutes = 15,
    allowRotation = false,
    rotationReason = null,
  }) {
    if (!['CHECK_IN', 'CHECK_OUT'].includes(action)) {
      const err = new Error(`Invalid action "${action}". Expected CHECK_IN or CHECK_OUT.`);
      err.statusCode = 400;
      err.code = 'INVALID_ACTION';
      throw err;
    }

    if (!adminId || Number.isNaN(Number(adminId))) {
      const err = new Error('adminId is required to generate a QR session.');
      err.statusCode = 401;
      err.code = 'UNAUTHORIZED';
      throw err;
    }

    const finalOfficeId = Number(officeId) || 1;
    const attendanceDate = istCalendarDate();
    const activeSlot = `${finalOfficeId}_${attendanceDate}_${action}`;
    const clampedValidity = Math.min(120, Math.max(1, Number(validityMinutes) || 15));

    // 1. Inspect existing sessions today
    const todaySessions = await AttendanceQrSessionModel.findAllToday({
      officeId: finalOfficeId,
      attendanceDate,
      action,
    });

    const activeSession = todaySessions.find((s) => s.status === 'ACTIVE');

    if (activeSession) {
      const expiresAtMs = fromUtcDateTime(activeSession.expires_at)?.getTime() || 0;
      const nowMs = Date.now();

      if (expiresAtMs > nowMs) {
        if (!allowRotation) {
          // Valid session already exists -> idempotent return with decrypted token
          const secondsRemaining = Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000));
          const recoveredToken = decryptToken(activeSession.encrypted_token);
          return {
            success: true,
            alreadyActive: true,
            sessionId: activeSession.id,
            qrToken: recoveredToken,
            action: activeSession.action,
            attendanceDate: activeSession.attendance_date,
            officeId: activeSession.office_id,
            expiresAt: activeSession.expires_at,
            secondsRemaining,
            generationSeq: activeSession.generation_seq,
          };
        }
      } else {
        // Expired in reality -> mark expired
        await AttendanceQrSessionModel.expire(null, activeSession.id);
        activeSession.status = 'EXPIRED';
      }
    }

    // 2. Enforce single generation per day rule
    if (todaySessions.length > 0 && !allowRotation) {
      const err = new Error(
        `QR session for ${action} on ${attendanceDate} has already been generated today. Administrative rotation requires an audited recovery authorization and reason.`
      );
      err.statusCode = 409;
      err.code = 'SINGLE_GEN_LIMIT';
      throw err;
    }

    if (allowRotation) {
      if (!rotationReason || typeof rotationReason !== 'string' || rotationReason.trim().length < 5) {
        const err = new Error('Administrative rotation requires a non-empty reason (at least 5 characters).');
        err.statusCode = 400;
        err.code = 'INVALID_ROTATION_REASON';
        throw err;
      }
    }

    // 3. Create new session in transaction
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      let generationSeq = 1;

      if (allowRotation) {
        // Revoke all previous sessions for this slot so old tokens cannot be used
        for (const prev of todaySessions) {
          if (prev.status !== 'REVOKED') {
            await AttendanceQrSessionModel.revoke(conn, {
              id: prev.id,
              adminId,
              reason: rotationReason.trim(),
            });
          }
        }
        const maxSeq = todaySessions.reduce((max, s) => Math.max(max, s.generation_seq || 0), 0);
        generationSeq = maxSeq + 1;
      }

      const rawToken = generateRawToken();
      const tokenHash = hashToken(rawToken);
      const encryptedToken = encryptToken(rawToken);
      const expiresAt = toUtcDateTime(new Date(Date.now() + clampedValidity * 60 * 1000));

      let sessionId = null;
      try {
        sessionId = await AttendanceQrSessionModel.create(conn, {
          sessionTokenHash: tokenHash,
          encryptedToken,
          officeId: finalOfficeId,
          attendanceDate,
          action,
          generationSeq,
          createdByAdminId: Number(adminId),
          expiresAt,
          activeSlot,
        });
      } catch (insertErr) {
        if (insertErr.code === 'ER_DUP_ENTRY' && insertErr.message.includes('uq_qr_active_slot')) {
          // Another concurrent request created an active session just now
          await conn.rollback();

          const winner = await AttendanceQrSessionModel.findActive({
            officeId: finalOfficeId,
            attendanceDate,
            action,
          });

          if (winner) {
            const expiresAtMs = fromUtcDateTime(winner.expires_at)?.getTime() || 0;
            const secondsRemaining = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
            const recoveredToken = decryptToken(winner.encrypted_token);
            return {
              success: true,
              alreadyActive: true,
              sessionId: winner.id,
              qrToken: recoveredToken,
              action: winner.action,
              attendanceDate: winner.attendance_date,
              officeId: winner.office_id,
              expiresAt: winner.expires_at,
              secondsRemaining,
              generationSeq: winner.generation_seq,
            };
          }
        }
        throw insertErr;
      }

      // Record audit log entry
      await AttendanceAuditLogModel.log(
        {
          actorAdminId: Number(adminId),
          action: allowRotation ? 'QR_ROTATION' : 'QR_GENERATION',
          entityType: 'attendance_qr_session',
          entityId: sessionId,
          beforeJson: allowRotation && activeSession ? { prevSessionId: activeSession.id, status: 'REVOKED' } : null,
          afterJson: {
            sessionId,
            officeId: finalOfficeId,
            action,
            attendanceDate,
            generationSeq,
            validityMinutes: clampedValidity,
            expiresAt,
            reason: allowRotation ? rotationReason.trim() : 'Initial daily generation',
          },
        },
        conn
      );

      await conn.commit();

      return {
        success: true,
        sessionId,
        qrToken: rawToken,
        action,
        attendanceDate,
        officeId: finalOfficeId,
        expiresAt,
        validityMinutes: clampedValidity,
        generationSeq,
        rotated: Boolean(allowRotation),
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  /**
   * Validate a raw scanned QR token.
   * Returns { valid: boolean, code?: string, message?: string, session?: object }
   */
  async validateToken({ rawToken, expectedAction = null, officeId = null }) {
    if (!rawToken || typeof rawToken !== 'string' || !rawToken.trim()) {
      return { valid: false, code: 'INVALID_QR', message: 'Invalid QR Code' };
    }

    const tokenHash = hashToken(rawToken);
    const session = await AttendanceQrSessionModel.findByHash(tokenHash);

    if (!session) {
      return { valid: false, code: 'INVALID_QR', message: 'Invalid QR Code' };
    }

    if (session.status === 'REVOKED') {
      return {
        valid: false,
        code: 'REVOKED_QR',
        message: 'QR Code has been revoked and is no longer valid',
      };
    }

    if (session.status === 'EXPIRED') {
      return { valid: false, code: 'EXPIRED_QR', message: 'QR Code Expired' };
    }

    const expiresAtMs = fromUtcDateTime(session.expires_at)?.getTime() || 0;
    if (expiresAtMs <= Date.now()) {
      // Lazily update status to EXPIRED
      AttendanceQrSessionModel.expire(null, session.id).catch(() => {});
      return { valid: false, code: 'EXPIRED_QR', message: 'QR Code Expired' };
    }

    if (session.status !== 'ACTIVE') {
      return { valid: false, code: 'INVALID_QR', message: 'Invalid QR Code' };
    }

    if (expectedAction && session.action !== expectedAction) {
      return {
        valid: false,
        code: 'ACTION_MISMATCH',
        message: `Invalid QR Code: expected ${expectedAction} token but received ${session.action}`,
      };
    }

    if (officeId != null && session.office_id !== Number(officeId)) {
      return {
        valid: false,
        code: 'OFFICE_MISMATCH',
        message: 'QR Code was issued for a different office location',
      };
    }

    return {
      valid: true,
      session,
    };
  },

  /**
   * Manually revoke an active session.
   */
  async revokeSession({ sessionId, adminId, reason }) {
    if (!sessionId) throw new Error('sessionId is required.');
    if (!adminId) throw new Error('adminId is required.');
    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      throw new Error('Revocation reason is required (at least 5 characters).');
    }

    const session = await AttendanceQrSessionModel.findById(sessionId);
    if (!session) {
      const err = new Error('QR session not found.');
      err.statusCode = 404;
      throw err;
    }

    if (session.status !== 'ACTIVE') {
      const err = new Error(`QR session is not active (current status: ${session.status}).`);
      err.statusCode = 400;
      throw err;
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await AttendanceQrSessionModel.revoke(conn, {
        id: sessionId,
        adminId: Number(adminId),
        reason: reason.trim(),
      });

      await AttendanceAuditLogModel.log(
        {
          actorAdminId: Number(adminId),
          action: 'QR_REVOCATION',
          entityType: 'attendance_qr_session',
          entityId: sessionId,
          beforeJson: { sessionId, status: 'ACTIVE' },
          afterJson: { sessionId, status: 'REVOKED', reason: reason.trim() },
        },
        conn
      );

      await conn.commit();
      return { success: true, message: 'QR session successfully revoked.' };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },
};

module.exports = QrSessionService;
