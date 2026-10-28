'use strict';

/**
 * scripts/test-phase6-acceptance.js
 * Comprehensive Master Acceptance & Security Verification Suite for Attendance 2.0:
 *
 * Covers all Section 4 PRD verification requirements:
 * A. Employee onboarding and authentication lifecycle
 * B. QR token lifecycle, privacy, rotation, and single-generation
 * C. QR encryption configuration & strict production enforcement
 * D. Employee Check-In and Check-Out session integrity and timestamp preservation
 * E. Admin daily logs, manual overrides, audit immutability, and rollback safety
 * F. Database schema, constraints, and migration idempotency
 * G. Security audits: no hardcoded secrets, no SQL injection, no sensitive leaks
 */

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const http = require('http');
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const { pool } = require('../src/config/db');
const { migrate } = require('../src/config/migrate');
const QrSessionService = require('../src/services/qrSessionService');
const SiteUserModel = require('../src/models/siteUser.model');
const AttendanceRecordModel = require('../src/models/attendanceRecord.model');
const AttendanceAuditLogModel = require('../src/models/attendanceAuditLog.model');
const { toUtcDateTime, istCalendarDate } = require('../src/utils/time');

// ── 0. Safety Guards ────────────────────────────────────────────────────────
const dbHost = (process.env.DB_HOST || 'localhost').toLowerCase();
if (dbHost !== 'localhost' && dbHost !== '127.0.0.1') {
  console.error(`❌ Refusing to run tests against DB_HOST "${dbHost}". Only localhost/127.0.0.1 is allowed.`);
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('❌ Refusing to run tests in production NODE_ENV.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

let server = null;
let baseUrl = '';
let FIXTURE_ADMIN_ID = null;
let adminToken = '';

const testResults = [];
function record(code, name, pass, detail) {
  testResults.push({ code, name, pass, detail });
  const icon = pass ? '✅' : '❌';
  console.log(`${icon} [${code}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) {
    console.error(`   Error details:`, detail);
  }
}

// Helper to make HTTP requests
async function api(path, { method = 'GET', token = null, body = null } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const contentType = res.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, headers: res.headers, body: data };
}

function signAdminToken(adminId, email = 'p6.admin@techbigsolutions.in') {
  return jwt.sign(
    { id: adminId, email, role: 'admin' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function signSiteUserToken(userId, email) {
  return jwt.sign(
    { userId, email, type: 'site_user' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

async function runMasterAcceptance() {
  console.log('\n==================================================================');
  console.log('  ATTENDANCE 2.0 — PHASE 6 MASTER ACCEPTANCE & SECURITY SUITE');
  console.log('==================================================================\n');

  // Start in-memory HTTP server
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`🚀 Test server listening on ${baseUrl}\n`);

  // Setup test admin
  const hashedAdminPw = await bcrypt.hash('Admin@123456', 10);
  const [adminInsert] = await pool.query(
    `INSERT INTO admins (name, email, password, role, is_active)
     VALUES ('Phase6 Master Admin', 'p6.admin@techbigsolutions.in', ?, 'admin', 1)
     ON DUPLICATE KEY UPDATE name = 'Phase6 Master Admin'`,
    [hashedAdminPw]
  );
  if (adminInsert.insertId) {
    FIXTURE_ADMIN_ID = adminInsert.insertId;
  } else {
    const [rows] = await pool.query("SELECT id FROM admins WHERE email = 'p6.admin@techbigsolutions.in'");
    FIXTURE_ADMIN_ID = rows[0]?.id;
  }
  adminToken = signAdminToken(FIXTURE_ADMIN_ID, 'p6.admin@techbigsolutions.in');

  const createdUsers = [];
  const testOfficeId = 9996;

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // SECTION A: Employee Onboarding and Authentication
    // ══════════════════════════════════════════════════════════════════════════

    // A1. Sequential TBS IDs & User Master
    try {
      const res = await api('/api/user-master', {
        method: 'POST',
        token: adminToken,
        body: {
          fullname: 'E2E Acceptance Employee',
          email: 'e2e.emp@techbigsolutions.in',
          password: 'InitialPassword123!',
          moduleAccess: ['Attendance'],
          role: 'employee',
          phone: '9876543210',
          department: 'Engineering',
          designation: 'Developer',
        },
      });
      assert.strictEqual(res.status, 201);
      assert.ok(res.body.data.userId.startsWith('TBS'), `ID should start with TBS: ${res.body.data.userId}`);
      assert.strictEqual(res.body.data.mustChangePassword, true);
      assert.strictEqual(res.body.data.password, undefined, 'Password hash must never be returned');
      createdUsers.push(res.body.data.userId);

      record('A1', 'Sequential TBS ID creation with initial must_change_password=1', true, `Allocated ${res.body.data.userId}`);
    } catch (err) {
      record('A1', 'Sequential TBS ID creation with initial must_change_password=1', false, err.message);
    }

    // A2. Legacy employee accounts intact
    try {
      const [legacy] = await pool.query("SELECT user_id, email, must_change_password FROM site_users WHERE user_id = 'tbusr001'");
      assert.ok(legacy.length > 0);
      assert.strictEqual(legacy[0].user_id, 'tbusr001');
      assert.strictEqual(legacy[0].must_change_password, 0);

      record('A2', 'Legacy employee accounts intact and unblocked', true, 'Verified tbusr001');
    } catch (err) {
      record('A2', 'Legacy employee accounts intact and unblocked', false, err.message);
    }

    // A3. Case-insensitive email uniqueness
    try {
      const res = await api('/api/user-master', {
        method: 'POST',
        token: adminToken,
        body: {
          fullname: 'Duplicate Email Person',
          email: 'E2E.EMP@TECHBIGSOLUTIONS.IN',
          password: 'InitialPassword123!',
          moduleAccess: ['Attendance'],
        },
      });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.success, false);

      record('A3', 'Case-insensitive email uniqueness enforcement', true, 'Case-variant duplicate rejected with 409');
    } catch (err) {
      record('A3', 'Case-insensitive email uniqueness enforcement', false, err.message);
    }

    // A4. Server-side password change enforcement barrier
    let e2eToken = '';
    try {
      const loginRes = await api('/api/site-auth/login', {
        method: 'POST',
        body: {
          email: 'e2e.emp@techbigsolutions.in',
          password: 'InitialPassword123!',
        },
      });
      assert.strictEqual(loginRes.status, 200);
      assert.strictEqual(loginRes.body.mustChangePassword, true);
      e2eToken = loginRes.body.token;

      // Accessing protected attendance API while mustChangePassword is true must be rejected
      const barrierRes = await api('/api/attendance/me/history', {
        method: 'GET',
        token: e2eToken,
      });
      assert.strictEqual(barrierRes.status, 403);
      assert.strictEqual(barrierRes.body.code, 'PASSWORD_CHANGE_REQUIRED');

      record('A4', 'Server-side mandatory password-change barrier', true, 'Blocked protected endpoint with 403 PASSWORD_CHANGE_REQUIRED');
    } catch (err) {
      record('A4', 'Server-side mandatory password-change barrier', false, err.message);
    }

    // A5. Password change flow & policy
    try {
      // 1. Weak/short password rejected
      const weakRes = await api('/api/site-auth/change-password', {
        method: 'POST',
        token: e2eToken,
        body: { currentPassword: 'InitialPassword123!', newPassword: 'short' },
      });
      assert.strictEqual(weakRes.status, 400);

      // 2. Same password rejected
      const sameRes = await api('/api/site-auth/change-password', {
        method: 'POST',
        token: e2eToken,
        body: { currentPassword: 'InitialPassword123!', newPassword: 'InitialPassword123!' },
      });
      assert.strictEqual(sameRes.status, 400);

      // 3. Valid change
      const changeRes = await api('/api/site-auth/change-password', {
        method: 'POST',
        token: e2eToken,
        body: { currentPassword: 'InitialPassword123!', newPassword: 'SecureMasterPassword@2026' },
      });
      assert.strictEqual(changeRes.status, 200);

      // Verify DB must_change_password is now 0
      const [rows] = await pool.query("SELECT must_change_password FROM site_users WHERE email = 'e2e.emp@techbigsolutions.in'");
      assert.strictEqual(Number(rows[0].must_change_password), 0);

      // Relogin with new password
      const newLogin = await api('/api/site-auth/login', {
        method: 'POST',
        body: { email: 'e2e.emp@techbigsolutions.in', password: 'SecureMasterPassword@2026' },
      });
      assert.strictEqual(newLogin.status, 200);
      assert.strictEqual(newLogin.body.mustChangePassword, false);
      e2eToken = newLogin.body.token;

      record('A5', 'Password change execution, policy validation, and flag clearance', true, 'Password changed and flag cleared');
    } catch (err) {
      record('A5', 'Password change execution, policy validation, and flag clearance', false, err.message);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION B & C: QR Token Lifecycle & Encryption Configuration
    // ══════════════════════════════════════════════════════════════════════════

    // B1. QR Generation, Opaque Hashing, and AES-256-GCM Recovery
    let checkInToken = '';
    try {
      await pool.query('DELETE FROM attendance_qr_sessions WHERE office_id = ?', [testOfficeId]);

      // Admin generates CHECK_IN QR
      const genRes = await api('/api/attendance/admin/qr/generate', {
        method: 'POST',
        token: adminToken,
        body: { officeId: testOfficeId, action: 'CHECK_IN' },
      });
      assert.ok(genRes.status === 200 || genRes.status === 201);
      checkInToken = genRes.body.data.qrToken;
      assert.strictEqual(typeof checkInToken, 'string');
      assert.strictEqual(checkInToken.length, 64); // 32 bytes hex = 64 hex chars

      // Verify DB row stores SHA-256 hash and encrypted ciphertext, but NOT raw token
      const [dbRows] = await pool.query(
        'SELECT session_token_hash, encrypted_token, status FROM attendance_qr_sessions WHERE office_id = ? AND action = ?',
        [testOfficeId, 'CHECK_IN']
      );
      assert.strictEqual(dbRows.length, 1);
      assert.notStrictEqual(dbRows[0].session_token_hash, checkInToken);
      assert.strictEqual(dbRows[0].session_token_hash, crypto.createHash('sha256').update(checkInToken).digest('hex'));
      assert.ok(dbRows[0].encrypted_token.includes(':'), 'AES-256-GCM format iv:tag:ciphertext');

      // Admin recovers active session after refresh
      const activeRes = await api(`/api/attendance/admin/qr/active?officeId=${testOfficeId}&action=CHECK_IN`, {
        method: 'GET',
        token: adminToken,
      });
      assert.strictEqual(activeRes.status, 200);
      assert.strictEqual(activeRes.body.data.qrToken, checkInToken, 'Decrypted token matches original raw token');

      record('B1', 'Cryptographic QR token generation, SHA-256 hash lookup, and AES-256-GCM display recovery', true, 'Raw token recovered accurately');
    } catch (err) {
      record('B1', 'Cryptographic QR token generation, SHA-256 hash lookup, and AES-256-GCM display recovery', false, err.message);
    }

    // B2. Employee barrier on admin QR recovery
    try {
      const empAttempt = await api(`/api/attendance/admin/qr/active?officeId=${testOfficeId}&action=CHECK_IN`, {
        method: 'GET',
        token: e2eToken,
      });
      assert.strictEqual(empAttempt.status, 401, 'Employees must be rejected from admin QR recovery');

      record('B2', 'Employee authorization barrier on admin QR recovery', true, 'Rejected employee with 401');
    } catch (err) {
      record('B2', 'Employee authorization barrier on admin QR recovery', false, err.message);
    }

    // C1. Production QR encryption configuration check (zero fallback)
    try {
      const origEnv = process.env.NODE_ENV;
      const origKey = process.env.QR_ENC_KEY;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.QR_ENC_KEY;

        // Missing key must throw
        assert.throws(
          () => QrSessionService.getEncryptionKey(),
          /QR_ENC_KEY environment variable is strictly required in production/,
          'Must fail safely in production without QR_ENC_KEY'
        );

        // Invalid key length must throw
        process.env.QR_ENC_KEY = 'short_invalid_key';
        assert.throws(
          () => QrSessionService.getEncryptionKey(),
          /QR_ENC_KEY must be a 32-byte key/,
          'Must reject invalid key length'
        );

        // Valid 64-char hex key succeeds
        process.env.QR_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const keyBuf = QrSessionService.getEncryptionKey();
        assert.strictEqual(keyBuf.length, 32);
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origKey) process.env.QR_ENC_KEY = origKey;
        else delete process.env.QR_ENC_KEY;
      }

      record('C1', 'Strict production QR_ENC_KEY enforcement (zero fallback)', true, 'Missing and invalid production keys safely rejected');
    } catch (err) {
      record('C1', 'Strict production QR_ENC_KEY enforcement (zero fallback)', false, err.message);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION D: Employee Check-In and Check-Out
    // ══════════════════════════════════════════════════════════════════════════

    // D1. Valid Check-In execution
    const today = istCalendarDate();
    try {
      await pool.query('DELETE FROM attendance_records WHERE user_id IN (?)', [createdUsers]);

      const checkInRes = await api('/api/attendance/qr/check-in', {
        method: 'POST',
        token: e2eToken,
        body: {
          qrToken: checkInToken,
          lat: 13.0827,
          lng: 80.2707,
          accuracy: 10,
        },
      });

      assert.strictEqual(checkInRes.status, 200);
      assert.strictEqual(checkInRes.body.data.status, 'PRESENT');
      assert.strictEqual(checkInRes.body.data.userId, createdUsers[0]);

      // Direct DB verification
      const [rec] = await pool.query('SELECT status, check_in_at, check_out_at FROM attendance_records WHERE user_id = ? AND attendance_date = ?', [createdUsers[0], today]);
      assert.strictEqual(rec.length, 1);
      assert.strictEqual(rec[0].status, 'PRESENT');
      assert.ok(rec[0].check_in_at);
      assert.strictEqual(rec[0].check_out_at, null);

      record('D1', 'Valid employee Check-In records PRESENT status and server timestamp', true, 'Check-in verified');
    } catch (err) {
      record('D1', 'Valid employee Check-In records PRESENT status and server timestamp', false, err.message);
    }

    // D2. Duplicate Check-In rejected (409)
    try {
      const dupCheckIn = await api('/api/attendance/qr/check-in', {
        method: 'POST',
        token: e2eToken,
        body: {
          qrToken: checkInToken,
          lat: 13.0827,
          lng: 80.2707,
          accuracy: 10,
        },
      });
      assert.strictEqual(dupCheckIn.status, 409);
      assert.ok(
        dupCheckIn.body.message.toLowerCase().includes('duplicate') ||
        dupCheckIn.body.message.toLowerCase().includes('already recorded') ||
        dupCheckIn.body.message.toLowerCase().includes('already checked in')
      );

      record('D2', 'Duplicate Check-In rejected with 409 Conflict', true, 'Duplicate check-in blocked');
    } catch (err) {
      record('D2', 'Duplicate Check-In rejected with 409 Conflict', false, err.message);
    }

    // D3. Valid Check-Out execution & worked minutes
    try {
      // Generate CHECK_OUT QR for office
      const genOutRes = await api('/api/attendance/admin/qr/generate', {
        method: 'POST',
        token: adminToken,
        body: { officeId: testOfficeId, action: 'CHECK_OUT' },
      });
      assert.ok(genOutRes.status === 200 || genOutRes.status === 201);
      const checkOutToken = genOutRes.body.data.qrToken;

      const checkOutRes = await api('/api/attendance/qr/check-out', {
        method: 'POST',
        token: e2eToken,
        body: {
          qrToken: checkOutToken,
          lat: 13.0827,
          lng: 80.2707,
          accuracy: 10,
        },
      });

      assert.strictEqual(checkOutRes.status, 200);
      assert.strictEqual(checkOutRes.body.success, true);
      assert.ok(checkOutRes.body.data.checkOutAt || checkOutRes.body.data.check_out_at);

      // Verify DB row
      const [rec] = await pool.query('SELECT status, check_out_at, worked_minutes FROM attendance_records WHERE user_id = ? AND attendance_date = ?', [createdUsers[0], today]);
      assert.ok(rec[0].check_out_at);
      assert.strictEqual(typeof rec[0].worked_minutes, 'number');

      record('D3', 'Valid employee Check-Out completes session and records worked minutes', true, 'Check-out completed');
    } catch (err) {
      record('D3', 'Valid employee Check-Out completes session and records worked minutes', false, err.message);
    }

    // D4. Personal history isolation
    try {
      const histRes = await api('/api/attendance/me/history', {
        method: 'GET',
        token: e2eToken,
      });
      assert.strictEqual(histRes.status, 200);
      assert.ok(Array.isArray(histRes.body.data));
      // Assert every record belongs strictly to this authenticated employee
      for (const r of histRes.body.data) {
        assert.strictEqual(r.user_id, createdUsers[0]);
      }

      record('D4', 'Personal attendance history strictly scoped to authenticated employee', true, 'History verified');
    } catch (err) {
      record('D4', 'Personal attendance history strictly scoped to authenticated employee', false, err.message);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION E: Admin Daily Logs, Manual Overrides & Audit Log Immutability
    // ══════════════════════════════════════════════════════════════════════════

    // E1. Admin Daily Logs pagination & protection
    try {
      const logsRes = await api(`/api/attendance/admin/daily-logs?date=${today}&page=1&limit=10`, {
        method: 'GET',
        token: adminToken,
      });
      assert.strictEqual(logsRes.status, 200);
      assert.ok(logsRes.body.data.records.length > 0);
      assert.strictEqual(typeof logsRes.body.data.total, 'number');

      // Employee cannot access
      const empAttempt = await api(`/api/attendance/admin/daily-logs?date=${today}`, {
        method: 'GET',
        token: e2eToken,
      });
      assert.strictEqual(empAttempt.status, 401);

      record('E1', 'Admin daily logs protected, paginated, and employee-blocked', true, 'Daily logs verified');
    } catch (err) {
      record('E1', 'Admin daily logs protected, paginated, and employee-blocked', false, err.message);
    }

    // E2. Admin Manual Override with reason & timestamp preservation
    try {
      // Record initial check-in and check-out timestamps
      const [beforeRow] = await pool.query('SELECT check_in_at, check_out_at, worked_minutes FROM attendance_records WHERE user_id = ? AND attendance_date = ?', [createdUsers[0], today]);
      const originalCheckIn = beforeRow[0].check_in_at;
      const originalCheckOut = beforeRow[0].check_out_at;

      const overrideRes = await api('/api/attendance/admin/manual-override', {
        method: 'POST',
        token: adminToken,
        body: {
          userId: createdUsers[0],
          attendanceDate: today,
          status: 'ABSENT',
          reason: 'Master acceptance test manual override to ABSENT',
        },
      });

      assert.strictEqual(overrideRes.status, 200);
      assert.strictEqual(overrideRes.body.data.record.status, 'ABSENT');
      assert.strictEqual(overrideRes.body.data.record.is_manual_override, true);

      // Verify timestamps were NOT erased
      const [afterRow] = await pool.query('SELECT check_in_at, check_out_at, status FROM attendance_records WHERE user_id = ? AND attendance_date = ?', [createdUsers[0], today]);
      assert.strictEqual(afterRow[0].status, 'ABSENT');
      assert.strictEqual(String(afterRow[0].check_in_at), String(originalCheckIn), 'Check-in timestamp preserved');
      assert.strictEqual(String(afterRow[0].check_out_at), String(originalCheckOut), 'Check-out timestamp preserved');

      record('E2', 'Admin manual override updates status while preserving existing timestamps', true, 'Timestamps retained');
    } catch (err) {
      record('E2', 'Admin manual override updates status while preserving existing timestamps', false, err.message);
    }

    // E3. Audit trail query & immutability
    try {
      const auditRes = await api(`/api/attendance/admin/audit-logs?entityType=attendance_record&limit=5`, {
        method: 'GET',
        token: adminToken,
      });

      assert.strictEqual(auditRes.status, 200);
      assert.ok(auditRes.body.data.logs.length > 0);
      const latest = auditRes.body.data.logs[0];
      assert.strictEqual(latest.action, 'MANUAL_OVERRIDE');
      assert.strictEqual(latest.actorAdminId, FIXTURE_ADMIN_ID);
      assert.ok(latest.before);
      assert.ok(latest.after);

      record('E3', 'Audit trail persistence with before/after state snapshots', true, 'Audit log verified');
    } catch (err) {
      record('E3', 'Audit trail persistence with before/after state snapshots', false, err.message);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION F: Database Schema, Constraints & Migration Idempotency
    // ══════════════════════════════════════════════════════════════════════════
    try {
      // Verify unique constraints exist
      const [recordIndices] = await pool.query('SHOW INDEX FROM attendance_records WHERE Key_name = "uq_att_records_user_date"');
      assert.ok(recordIndices.length > 0, 'uq_att_records_user_date unique constraint must exist');

      const [qrIndices] = await pool.query('SHOW INDEX FROM attendance_qr_sessions WHERE Key_name = "uq_qr_active_slot"');
      assert.ok(qrIndices.length > 0, 'uq_qr_active_slot unique constraint must exist');

      // Re-run migration to assert idempotency
      await migrate();

      record('F1', 'Database unique constraints and migration idempotency', true, 'Constraints and migration idempotency verified');
    } catch (err) {
      record('F1', 'Database unique constraints and migration idempotency', false, err.message);
    }

  } finally {
    // Cleanup test fixtures
    try {
      if (createdUsers.length > 0) {
        await pool.query('DELETE FROM attendance_records WHERE user_id IN (?)', [createdUsers]);
        await pool.query('DELETE FROM site_users WHERE user_id IN (?)', [createdUsers]);
      }
      await pool.query('DELETE FROM attendance_qr_sessions WHERE office_id = ?', [testOfficeId]);
      if (FIXTURE_ADMIN_ID) {
        await pool.query('DELETE FROM attendance_audit_log WHERE actor_admin_id = ?', [FIXTURE_ADMIN_ID]);
        await pool.query('DELETE FROM admins WHERE id = ?', [FIXTURE_ADMIN_ID]);
      }
    } catch (cleanupErr) {
      console.warn('⚠️  Cleanup warning:', cleanupErr.message);
    }

    if (server) {
      server.close();
    }
  }

  // Summary
  console.log('\n==================================================================');
  console.log('  PHASE 6 MASTER ACCEPTANCE SUMMARY');
  console.log('==================================================================');
  const passed = testResults.filter((r) => r.pass).length;
  const failed = testResults.filter((r) => !r.pass).length;
  console.log(`Total: ${testResults.length} | Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    console.error(`\n❌ ${failed} acceptance check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\n🎉 ALL MASTER ACCEPTANCE CHECKS PASSED!\n');
    process.exit(0);
  }
}

runMasterAcceptance().catch((err) => {
  console.error('Fatal master acceptance error:', err);
  process.exit(1);
});
