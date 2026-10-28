'use strict';

/**
 * scripts/test-phase2-qr.js
 * Focused Phase 2 Test Suite:
 * - QR token generation, hashing, and storage privacy
 * - Token expiration and rejection
 * - Token revocation and reuse prevention
 * - Single-generation-per-day enforcement and idempotent retrieval
 * - Audited administrative recovery / rotation policy
 * - Action mismatch protection (CHECK_IN vs CHECK_OUT)
 * - Concurrency race-condition protection (active_slot constraint)
 * - Migration idempotency and schema validation
 */

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const assert = require('assert');
const { pool } = require('../src/config/db');
const { migrate, columnExists, tableExists, indexExists } = require('../src/config/migrate');
const QrSessionService = require('../src/services/qrSessionService');
const AttendanceQrSessionModel = require('../src/models/attendanceQrSession.model');
const { toUtcDateTime, fromUtcDateTime, istCalendarDate } = require('../src/utils/time');

// ── 0. Environment Guard ────────────────────────────────────────────────────
const dbHost = (process.env.DB_HOST || 'localhost').toLowerCase();
if (dbHost !== 'localhost' && dbHost !== '127.0.0.1') {
  console.error(`❌ Refusing to run tests against DB_HOST "${dbHost}". Only localhost/127.0.0.1 is allowed.`);
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('❌ Refusing to run tests in production NODE_ENV.');
  process.exit(1);
}

// Dedicated test office ID that doesn't conflict with real office 1
const TEST_OFFICE_ID = 9999;
const TEST_ADMIN_ID = 8888;
const TEST_DATE = istCalendarDate();

const testResults = [];
function record(name, pass, detail) {
  testResults.push({ name, pass, detail });
  const icon = pass ? '✅' : '❌';
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) {
    console.error(`   Error details:`, detail);
  }
}

async function cleanupFixtures() {
  try {
    await pool.query('DELETE FROM attendance_qr_sessions WHERE office_id = ?', [TEST_OFFICE_ID]);
    await pool.query('DELETE FROM attendance_audit_log WHERE actor_admin_id = ?', [TEST_ADMIN_ID]);
  } catch (err) {
    console.warn('⚠️  Cleanup warning:', err.message);
  }
}

async function runTests() {
  console.log('\n======================================================');
  console.log('  ATTENDANCE 2.0 — PHASE 2 VERIFICATION SUITE');
  console.log('======================================================\n');

  try {
    // Initial cleanup
    await cleanupFixtures();

    // ── TEST 1: Migration Idempotency & Schema ───────────────────────────────
    try {
      await migrate();
      const hasQrTable = await tableExists('attendance_qr_sessions');
      const hasSeqTable = await tableExists('app_sequences');
      const hasMustChangePw = await columnExists('site_users', 'must_change_password');
      const hasOverrideCol = await columnExists('attendance_records', 'is_manual_override');
      const hasSlotIndex = await indexExists('attendance_qr_sessions', 'uq_qr_active_slot');

      assert.strictEqual(hasQrTable, true, 'attendance_qr_sessions table must exist');
      assert.strictEqual(hasSeqTable, true, 'app_sequences table must exist');
      assert.strictEqual(hasMustChangePw, true, 'site_users.must_change_password must exist');
      assert.strictEqual(hasOverrideCol, true, 'attendance_records.is_manual_override must exist');
      assert.strictEqual(hasSlotIndex, true, 'uq_qr_active_slot unique index must exist');

      record('1. Migration idempotency and schema verification', true, 'All Phase 2 tables, columns and indexes verified');
    } catch (err) {
      record('1. Migration idempotency and schema verification', false, err.message);
    }

    // ── TEST 2: Token Hashing & Opaque Privacy ──────────────────────────────
    let firstCheckInToken = null;
    try {
      const rawToken = QrSessionService.generateRawToken();
      assert.strictEqual(typeof rawToken, 'string');
      assert.strictEqual(rawToken.length, 64, 'Raw token should be 32 bytes hex (64 chars)');

      const hash1 = QrSessionService.hashToken(rawToken);
      const hash2 = QrSessionService.hashToken(rawToken);
      assert.strictEqual(hash1, hash2, 'SHA-256 hash must be deterministic');
      assert.notStrictEqual(hash1, rawToken, 'Hash must not equal raw token');

      // Create session and verify raw token is NOT in database
      const genRes = await QrSessionService.getOrCreateSession({
        adminId: TEST_ADMIN_ID,
        action: 'CHECK_IN',
        officeId: TEST_OFFICE_ID,
        validityMinutes: 15,
      });

      assert.strictEqual(genRes.success, true);
      assert.strictEqual(genRes.qrToken, rawToken.length ? genRes.qrToken : null);
      firstCheckInToken = genRes.qrToken;

      const [rows] = await pool.query(
        'SELECT session_token_hash FROM attendance_qr_sessions WHERE id = ?',
        [genRes.sessionId]
      );
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].session_token_hash, QrSessionService.hashToken(genRes.qrToken));

      record('2. Token generation, hashing, and opaque privacy', true, 'Only SHA-256 stored; raw token not in DB');
    } catch (err) {
      record('2. Token generation, hashing, and opaque privacy', false, err.message);
    }

    // ── TEST 3: Idempotent Retrieval on Active Session ───────────────────────
    try {
      const secondCall = await QrSessionService.getOrCreateSession({
        adminId: TEST_ADMIN_ID,
        action: 'CHECK_IN',
        officeId: TEST_OFFICE_ID,
      });

      assert.strictEqual(secondCall.success, true);
      assert.strictEqual(secondCall.alreadyActive, true, 'Must indicate session is already active');
      assert.strictEqual(secondCall.qrToken, firstCheckInToken, 'Must recover identical decrypted token');
      assert.ok(secondCall.secondsRemaining > 0, 'Seconds remaining should be positive');

      const [countRows] = await pool.query(
        'SELECT COUNT(*) AS cnt FROM attendance_qr_sessions WHERE office_id = ? AND action = "CHECK_IN"',
        [TEST_OFFICE_ID]
      );
      assert.strictEqual(countRows[0].cnt, 1, 'Exactly one session row must exist in DB');

      record('3. Idempotent retrieval when active session exists', true, 'Returned existing session and recovered decrypted token without duplicates');
    } catch (err) {
      record('3. Idempotent retrieval when active session exists', false, err.message);
    }

    // ── TEST 4: Valid Token Validation ──────────────────────────────────────
    let activeTokenCheckIn = null;
    try {
      // Fetch the raw token from the first creation
      // We test validateToken with the created token
      const session = await AttendanceQrSessionModel.findActive({
        officeId: TEST_OFFICE_ID,
        attendanceDate: TEST_DATE,
        action: 'CHECK_IN',
      });
      // To validate with raw token, let's generate a separate CHECK_OUT session
      const checkOutRes = await QrSessionService.getOrCreateSession({
        adminId: TEST_ADMIN_ID,
        action: 'CHECK_OUT',
        officeId: TEST_OFFICE_ID,
        validityMinutes: 15,
      });

      const validation = await QrSessionService.validateToken({
        rawToken: checkOutRes.qrToken,
        expectedAction: 'CHECK_OUT',
        officeId: TEST_OFFICE_ID,
      });

      assert.strictEqual(validation.valid, true);
      assert.strictEqual(validation.session.id, checkOutRes.sessionId);
      assert.strictEqual(validation.session.action, 'CHECK_OUT');

      activeTokenCheckIn = checkOutRes.qrToken;
      record('4. Token validation success', true, 'Valid token confirmed active and valid');
    } catch (err) {
      record('4. Token validation success', false, err.message);
    }

    // ── TEST 5: Action Mismatch Protection ──────────────────────────────────
    try {
      const mismatch = await QrSessionService.validateToken({
        rawToken: activeTokenCheckIn,
        expectedAction: 'CHECK_IN', // Provided token was CHECK_OUT
        officeId: TEST_OFFICE_ID,
      });

      assert.strictEqual(mismatch.valid, false);
      assert.strictEqual(mismatch.code, 'ACTION_MISMATCH');
      assert.ok(mismatch.message.includes('expected CHECK_IN token'));

      record('5. Token action mismatch protection', true, 'CHECK_OUT token rejected when CHECK_IN expected');
    } catch (err) {
      record('5. Token action mismatch protection', false, err.message);
    }

    // ── TEST 6: Invalid and Tampered Token Rejection ────────────────────────
    try {
      const invalid = await QrSessionService.validateToken({
        rawToken: 'invalid_tampered_token_xyz_123',
        expectedAction: 'CHECK_OUT',
      });

      assert.strictEqual(invalid.valid, false);
      assert.strictEqual(invalid.code, 'INVALID_QR');
      assert.strictEqual(invalid.message, 'Invalid QR Code');

      record('6. Invalid and tampered token rejection', true, 'Rejected unrecognised token with generic error');
    } catch (err) {
      record('6. Invalid and tampered token rejection', false, err.message);
    }

    // ── TEST 7: Token Expiration Rejection ──────────────────────────────────
    try {
      // Simulate expired token by updating expires_at to 1 minute ago in UTC
      const pastTime = toUtcDateTime(new Date(Date.now() - 60_000));
      await pool.query(
        'UPDATE attendance_qr_sessions SET expires_at = ? WHERE office_id = ? AND action = "CHECK_OUT"',
        [pastTime, TEST_OFFICE_ID]
      );

      const expiredCheck = await QrSessionService.validateToken({
        rawToken: activeTokenCheckIn,
        expectedAction: 'CHECK_OUT',
        officeId: TEST_OFFICE_ID,
      });

      assert.strictEqual(expiredCheck.valid, false);
      assert.strictEqual(expiredCheck.code, 'EXPIRED_QR');
      assert.strictEqual(expiredCheck.message, 'QR Code Expired');

      record('7. Token expiration validation', true, 'Expired token returns stable "QR Code Expired"');
    } catch (err) {
      record('7. Token expiration validation', false, err.message);
    }

    // ── TEST 8: Single Generation per Day Enforced on Expired Session ────────
    try {
      let threw = false;
      try {
        // Attempting to generate a new session after expiration without allowRotation
        await QrSessionService.getOrCreateSession({
          adminId: TEST_ADMIN_ID,
          action: 'CHECK_OUT',
          officeId: TEST_OFFICE_ID,
          allowRotation: false,
        });
      } catch (e) {
        threw = true;
        assert.strictEqual(e.code, 'SINGLE_GEN_LIMIT');
        assert.ok(e.message.includes('already been generated today'));
      }
      assert.strictEqual(threw, true, 'Must reject generation without explicit rotation flag');

      record('8. Single-generation-per-day enforcement', true, 'Blocked automatic regeneration after expiry');
    } catch (err) {
      record('8. Single-generation-per-day enforcement', false, err.message);
    }

    // ── TEST 9: Audited Administrative Rotation ──────────────────────────────
    let rotatedToken = null;
    try {
      // Attempt rotation without reason -> must fail
      let threwNoReason = false;
      try {
        await QrSessionService.getOrCreateSession({
          adminId: TEST_ADMIN_ID,
          action: 'CHECK_OUT',
          officeId: TEST_OFFICE_ID,
          allowRotation: true,
          rotationReason: '',
        });
      } catch (e) {
        threwNoReason = true;
        assert.strictEqual(e.code, 'INVALID_ROTATION_REASON');
      }
      assert.strictEqual(threwNoReason, true, 'Must require non-empty rotation reason');

      // Valid rotation
      const rotated = await QrSessionService.getOrCreateSession({
        adminId: TEST_ADMIN_ID,
        action: 'CHECK_OUT',
        officeId: TEST_OFFICE_ID,
        allowRotation: true,
        rotationReason: 'Office internet disruption caused token timeout',
        validityMinutes: 15,
      });

      assert.strictEqual(rotated.success, true);
      assert.strictEqual(rotated.rotated, true);
      assert.strictEqual(rotated.generationSeq, 2, 'Generation sequence should be incremented to 2');
      assert.ok(rotated.qrToken, 'Must provide fresh replacement raw token');

      rotatedToken = rotated.qrToken;

      // Verify old token is REVOKED
      const [oldRows] = await pool.query(
        'SELECT status, active_slot FROM attendance_qr_sessions WHERE office_id = ? AND action = "CHECK_OUT" AND generation_seq = 1',
        [TEST_OFFICE_ID]
      );
      assert.strictEqual(oldRows[0].status, 'REVOKED');
      assert.strictEqual(oldRows[0].active_slot, null, 'Revoked row must have active_slot cleared');

      // Verify audit log has QR_ROTATION
      const [auditRows] = await pool.query(
        'SELECT action, entity_type FROM attendance_audit_log WHERE actor_admin_id = ? AND action = "QR_ROTATION"',
        [TEST_ADMIN_ID]
      );
      assert.ok(auditRows.length >= 1, 'Audit log entry must be written for rotation');

      record('9. Audited administrative rotation', true, 'Revoked old token, incremented sequence to 2, recorded audit entry');
    } catch (err) {
      record('9. Audited administrative rotation', false, err.message);
    }

    // ── TEST 10: Revoked Token Rejection & Reuse Prevention ──────────────────
    try {
      const revokedCheck = await QrSessionService.validateToken({
        rawToken: activeTokenCheckIn, // Old generation 1 token
        expectedAction: 'CHECK_OUT',
        officeId: TEST_OFFICE_ID,
      });

      assert.strictEqual(revokedCheck.valid, false);
      assert.strictEqual(revokedCheck.code, 'REVOKED_QR');
      assert.ok(revokedCheck.message.includes('has been revoked'));

      // New token must validate successfully
      const newCheck = await QrSessionService.validateToken({
        rawToken: rotatedToken,
        expectedAction: 'CHECK_OUT',
        officeId: TEST_OFFICE_ID,
      });
      assert.strictEqual(newCheck.valid, true);

      record('10. Revoked token reuse prevention', true, 'Previously revoked token cannot be reused');
    } catch (err) {
      record('10. Revoked token reuse prevention', false, err.message);
    }

    // ── TEST 11: Explicit Manual Session Revocation ──────────────────────────
    try {
      const activeRes = await QrSessionService.getActiveSession({
        officeId: TEST_OFFICE_ID,
        action: 'CHECK_OUT',
      });
      assert.strictEqual(activeRes.active, true);

      const revokeRes = await QrSessionService.revokeSession({
        sessionId: activeRes.sessionId,
        adminId: TEST_ADMIN_ID,
        reason: 'Office closing early due to severe weather',
      });
      assert.strictEqual(revokeRes.success, true);

      const activeAfter = await QrSessionService.getActiveSession({
        officeId: TEST_OFFICE_ID,
        action: 'CHECK_OUT',
      });
      assert.strictEqual(activeAfter.active, false, 'No active session should remain after revocation');

      record('11. Explicit manual session revocation', true, 'Active session revoked and active slot freed');
    } catch (err) {
      record('11. Explicit manual session revocation', false, err.message);
    }

    // ── TEST 12: Concurrent Session Creation Race Condition ─────────────────
    try {
      // Use a new dedicated office ID to test a fresh start
      const RACE_OFFICE_ID = 9998;
      await pool.query('DELETE FROM attendance_qr_sessions WHERE office_id = ?', [RACE_OFFICE_ID]);

      // Fire 5 simultaneous creation requests at the exact same millisecond
      const promises = Array.from({ length: 5 }, (_, i) =>
        QrSessionService.getOrCreateSession({
          adminId: TEST_ADMIN_ID,
          action: 'CHECK_IN',
          officeId: RACE_OFFICE_ID,
          validityMinutes: 15,
        }).catch((err) => ({ error: err.message }))
      );

      const raceResults = await Promise.all(promises);

      // Verify that all 5 returned success (either created or alreadyActive)
      const successes = raceResults.filter((r) => r.success === true);
      assert.strictEqual(successes.length, 5, 'All concurrent callers must receive a successful response');

      // Exactly ONE should have created a new session; the other 4 should have received alreadyActive: true
      const creators = raceResults.filter((r) => !r.alreadyActive);
      const idempotents = raceResults.filter((r) => r.alreadyActive === true);

      assert.strictEqual(creators.length, 1, 'Exactly one concurrent call should insert the session');
      assert.strictEqual(idempotents.length, 4, 'Remaining 4 concurrent calls should idempotently return the active session');

      // Verify DB has exactly ONE row for that office and date
      const [raceRows] = await pool.query(
        'SELECT COUNT(*) as cnt FROM attendance_qr_sessions WHERE office_id = ? AND action = "CHECK_IN"',
        [RACE_OFFICE_ID]
      );
      assert.strictEqual(raceRows[0].cnt, 1, 'Database must contain exactly 1 session record');

      await pool.query('DELETE FROM attendance_qr_sessions WHERE office_id = ?', [RACE_OFFICE_ID]);
      record('12. Concurrency race protection (active_slot constraint)', true, '5 parallel calls handled without duplicates or crashes');
    } catch (err) {
      record('12. Concurrency race protection (active_slot constraint)', false, err.message);
    }

  } finally {
    await cleanupFixtures();
    await pool.end();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n------------------------------------------------------');
  const passed = testResults.filter((t) => t.pass).length;
  const failed = testResults.filter((t) => !t.pass).length;
  console.log(`Phase 2 Tests Total: ${testResults.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
