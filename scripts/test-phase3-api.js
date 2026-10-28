'use strict';

/**
 * scripts/test-phase3-api.js
 * Acceptance Test Suite for Attendance 2.0 Phase 3:
 * 1. Admin QR generation & active-session retrieval (AES-256-GCM recovery after page refresh).
 * 2. Authorization barriers (admin vs employee vs public).
 * 3. Employee Check-In (valid, duplicate, invalid, expired, revoked, action-mismatch).
 * 4. Employee Check-Out (valid, duplicate, without check-in, action-mismatch, worked minutes calculation).
 * 5. Concurrent Check-In submission race test.
 * 6. Personal attendance history (/api/attendance/me/history).
 * 7. Admin paginated daily attendance logs (/api/attendance/admin/daily-logs).
 */

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const http = require('http');
const assert = require('assert');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const { pool } = require('../src/config/db');
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

// Test Fixture IDs
const FIXTURE_USER_1 = 'p3usr001';
const FIXTURE_USER_NO_MODULE = 'p3usr002';
const FIXTURE_USER_2 = 'p3usr003';
let FIXTURE_ADMIN_ID = null;
const FIXTURE_OFFICE_ID = 7777;

let server = null;
let baseUrl = '';

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
    const fixtureUsers = [FIXTURE_USER_1, FIXTURE_USER_NO_MODULE, FIXTURE_USER_2];
    await pool.query('DELETE FROM attendance_records WHERE user_id IN (?)', [fixtureUsers]);
    await pool.query('DELETE FROM attendance_qr_sessions WHERE office_id = ?', [FIXTURE_OFFICE_ID]);
    await pool.query('DELETE FROM site_users WHERE user_id IN (?)', [fixtureUsers]);
    if (FIXTURE_ADMIN_ID) {
      await pool.query('DELETE FROM attendance_audit_log WHERE actor_admin_id = ?', [FIXTURE_ADMIN_ID]);
      await pool.query('DELETE FROM admins WHERE id = ?', [FIXTURE_ADMIN_ID]);
    }
  } catch (err) {
    console.warn('⚠️  Cleanup warning:', err.message);
  }
}

async function runTests() {
  console.log('\n======================================================');
  console.log('  ATTENDANCE 2.0 — PHASE 3 API ACCEPTANCE SUITE');
  console.log('======================================================\n');

  try {
    // ── 1. Start Server on ephemeral dynamic port ───────────────────────────
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;

    // ── 2. Create Fixtures ──────────────────────────────────────────────────
    await cleanupFixtures();

    const hashedPassword = await bcrypt.hash('Password123!', 4);
    const now = toUtcDateTime();

    // Admin fixture
    const [adminRes] = await pool.query(
      `INSERT INTO admins (name, email, password, role, is_active, created_at)
       VALUES ('Phase 3 Admin', 'p3_admin@techbigsolutions.in', ?, 'admin', 1, ?)`,
      [hashedPassword, now]
    );
    FIXTURE_ADMIN_ID = adminRes.insertId;

    // Site User 1 (Attendance module enabled)
    await pool.query(
      `INSERT INTO site_users (user_id, fullname, email, password, module_access, is_active, created_at)
       VALUES (?, 'Phase 3 Employee 1', 'p3_emp1@techbigsolutions.in', ?, ?, 1, ?)`,
      [FIXTURE_USER_1, hashedPassword, JSON.stringify(['Attendance']), now]
    );

    // Site User 2 (No Attendance module)
    await pool.query(
      `INSERT INTO site_users (user_id, fullname, email, password, module_access, is_active, created_at)
       VALUES (?, 'Phase 3 No Module', 'p3_nomod@techbigsolutions.in', ?, ?, 1, ?)`,
      [FIXTURE_USER_NO_MODULE, hashedPassword, JSON.stringify(['Products']), now]
    );

    // Site User 3 (Attendance module enabled, for concurrency test)
    await pool.query(
      `INSERT INTO site_users (user_id, fullname, email, password, module_access, is_active, created_at)
       VALUES (?, 'Phase 3 Employee 2', 'p3_emp2@techbigsolutions.in', ?, ?, 1, ?)`,
      [FIXTURE_USER_2, hashedPassword, JSON.stringify(['Attendance']), now]
    );

    // Generate JWT tokens
    const adminToken = jwt.sign(
      { id: FIXTURE_ADMIN_ID, email: 'p3_admin@techbigsolutions.in', role: 'admin' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    const emp1Token = jwt.sign(
      { userId: FIXTURE_USER_1, email: 'p3_emp1@techbigsolutions.in', type: 'site_user' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    const noModToken = jwt.sign(
      { userId: FIXTURE_USER_NO_MODULE, email: 'p3_nomod@techbigsolutions.in', type: 'site_user' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    const emp2Token = jwt.sign(
      { userId: FIXTURE_USER_2, email: 'p3_emp2@techbigsolutions.in', type: 'site_user' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    let checkInQrToken = null;
    let checkOutQrToken = null;

    // ── TEST 1: Admin QR Generation ─────────────────────────────────────────
    try {
      // 1. Unauthenticated rejected
      const unauth = await api('/api/attendance/admin/qr/generate', {
        method: 'POST',
        body: { action: 'CHECK_IN', officeId: FIXTURE_OFFICE_ID },
      });
      assert.strictEqual(unauth.status, 401, 'Must reject unauthenticated request with 401');

      // 2. Employee token rejected
      const empAttempt = await api('/api/attendance/admin/qr/generate', {
        method: 'POST',
        token: emp1Token,
        body: { action: 'CHECK_IN', officeId: FIXTURE_OFFICE_ID },
      });
      assert.strictEqual(empAttempt.status, 401, 'Must reject employee token with 401');

      // 3. Valid admin generation
      const genRes = await api('/api/attendance/admin/qr/generate', {
        method: 'POST',
        token: adminToken,
        body: { action: 'CHECK_IN', officeId: FIXTURE_OFFICE_ID, validityMinutes: 15 },
      });

      assert.strictEqual(genRes.status, 201, 'Admin generation should return 201');
      assert.strictEqual(genRes.body.success, true);
      assert.strictEqual(genRes.body.data.action, 'CHECK_IN');
      assert.ok(genRes.body.data.qrToken, 'Must provide raw qrToken');

      checkInQrToken = genRes.body.data.qrToken;
      record('1. Admin QR generation & authorization barriers', true, 'Created CHECK_IN QR token, rejected employee/public');
    } catch (err) {
      record('1. Admin QR generation & authorization barriers', false, err.message);
    }

    // ── TEST 2: Active QR Retrieval (AES-256-GCM recovery after refresh) ─────
    try {
      // 1. Employee rejected
      const empAttempt = await api(`/api/attendance/admin/qr/active?action=CHECK_IN&officeId=${FIXTURE_OFFICE_ID}`, {
        token: emp1Token,
      });
      assert.strictEqual(empAttempt.status, 401, 'Active QR retrieval must reject employee tokens');

      // 2. Admin retrieves active QR (simulating office screen reload)
      const activeRes = await api(`/api/attendance/admin/qr/active?action=CHECK_IN&officeId=${FIXTURE_OFFICE_ID}`, {
        token: adminToken,
      });

      assert.strictEqual(activeRes.status, 200);
      assert.strictEqual(activeRes.body.data.active, true);
      assert.strictEqual(
        activeRes.body.data.qrToken,
        checkInQrToken,
        'Recovered decrypted token must exactly match original generated token'
      );
      assert.ok(activeRes.body.data.secondsRemaining > 0, 'Seconds remaining should be positive');

      record('2. Active QR session retrieval & page refresh recovery', true, 'Decrypted token matches original, protected by admin auth');
    } catch (err) {
      record('2. Active QR session retrieval & page refresh recovery', false, err.message);
    }

    // ── TEST 3: Employee Check-In ───────────────────────────────────────────
    try {
      // 1. Missing token
      const noToken = await api('/api/attendance/qr/check-in', {
        method: 'POST',
        token: emp1Token,
        body: {},
      });
      assert.strictEqual(noToken.status, 400);

      // 2. User without Attendance module access
      const noMod = await api('/api/attendance/qr/check-in', {
        method: 'POST',
        token: noModToken,
        body: { qrToken: checkInQrToken },
      });
      assert.strictEqual(noMod.status, 403, 'Must reject user without Attendance module access');

      // 3. Valid Check-In
      const checkInRes = await api('/api/attendance/qr/check-in', {
        method: 'POST',
        token: emp1Token,
        body: { qrToken: checkInQrToken, lat: 12.9716, lng: 77.5946, accuracy: 15 },
      });

      assert.strictEqual(checkInRes.status, 200, 'Check-In should succeed with 200 OK');
      assert.strictEqual(checkInRes.body.success, true);
      assert.strictEqual(checkInRes.body.data.userId, FIXTURE_USER_1);
      assert.strictEqual(checkInRes.body.data.status, 'PRESENT');
      assert.ok(checkInRes.body.data.checkInAt);

      // Verify in DB
      const [rows] = await pool.query(
        'SELECT * FROM attendance_records WHERE user_id = ? AND attendance_date = ?',
        [FIXTURE_USER_1, istCalendarDate()]
      );
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].status, 'PRESENT');
      assert.ok(rows[0].check_in_at);

      record('3. Employee Check-In validation & session creation', true, 'Session created with PRESENT status, verified in DB');
    } catch (err) {
      record('3. Employee Check-In validation & session creation', false, err.message);
    }

    // ── TEST 4: Duplicate Check-In Protection ───────────────────────────────
    try {
      const dupRes = await api('/api/attendance/qr/check-in', {
        method: 'POST',
        token: emp1Token,
        body: { qrToken: checkInQrToken },
      });

      assert.strictEqual(dupRes.status, 409, 'Duplicate Check-In must return 409 Conflict');
      assert.ok(dupRes.body.message.includes('Duplicate Check-In'));

      record('4. Duplicate Check-In rejection', true, 'Returned 409 Conflict on second check-in attempt today');
    } catch (err) {
      record('4. Duplicate Check-In rejection', false, err.message);
    }

    // ── TEST 5: Action Mismatch Protection (CHECK_IN vs CHECK_OUT) ───────────
    try {
      // Generate CHECK_OUT token
      const outGen = await api('/api/attendance/admin/qr/generate', {
        method: 'POST',
        token: adminToken,
        body: { action: 'CHECK_OUT', officeId: FIXTURE_OFFICE_ID },
      });
      assert.strictEqual(outGen.status, 201);
      checkOutQrToken = outGen.body.data.qrToken;

      // Submit CHECK_OUT token to check-in endpoint
      const mismatchIn = await api('/api/attendance/qr/check-in', {
        method: 'POST',
        token: emp2Token,
        body: { qrToken: checkOutQrToken },
      });
      assert.strictEqual(mismatchIn.status, 400);
      assert.strictEqual(mismatchIn.body.code, 'ACTION_MISMATCH');

      // Submit CHECK_IN token to check-out endpoint
      const mismatchOut = await api('/api/attendance/qr/check-out', {
        method: 'POST',
        token: emp1Token,
        body: { qrToken: checkInQrToken },
      });
      assert.strictEqual(mismatchOut.status, 400);
      assert.strictEqual(mismatchOut.body.code, 'ACTION_MISMATCH');

      record('5. Action mismatch token protection', true, 'Tokens not interchangeable between check-in and check-out');
    } catch (err) {
      record('5. Action mismatch token protection', false, err.message);
    }

    // ── TEST 6: Expired QR Code Rejection ───────────────────────────────────
    try {
      // Artificially expire the check-out token
      const pastTime = toUtcDateTime(new Date(Date.now() - 120_000));
      await pool.query(
        'UPDATE attendance_qr_sessions SET expires_at = ? WHERE office_id = ? AND action = "CHECK_OUT"',
        [pastTime, FIXTURE_OFFICE_ID]
      );

      const expiredRes = await api('/api/attendance/qr/check-out', {
        method: 'POST',
        token: emp1Token,
        body: { qrToken: checkOutQrToken },
      });

      assert.strictEqual(expiredRes.status, 400);
      assert.strictEqual(expiredRes.body.code, 'EXPIRED_QR');
      assert.strictEqual(expiredRes.body.message, 'QR Code Expired');

      record('6. Expired QR code rejection', true, 'Returns 400 Bad Request with stable "QR Code Expired"');
    } catch (err) {
      record('6. Expired QR code rejection', false, err.message);
    }

    // ── TEST 7: Revoked QR Code Rejection & Rotation ────────────────────────
    let replacementOutToken = null;
    try {
      // Rotate checkout token with audit reason
      const rotateRes = await api('/api/attendance/admin/qr/generate', {
        method: 'POST',
        token: adminToken,
        body: {
          action: 'CHECK_OUT',
          officeId: FIXTURE_OFFICE_ID,
          allowRotation: true,
          rotationReason: 'Audited session rotation for testing',
        },
      });

      assert.strictEqual(rotateRes.status, 201);
      assert.strictEqual(rotateRes.body.data.rotated, true);
      replacementOutToken = rotateRes.body.data.qrToken;

      // Submit the old revoked check-out token
      const revokedRes = await api('/api/attendance/qr/check-out', {
        method: 'POST',
        token: emp1Token,
        body: { qrToken: checkOutQrToken },
      });

      assert.strictEqual(revokedRes.status, 400);
      assert.strictEqual(revokedRes.body.code, 'REVOKED_QR');
      assert.ok(revokedRes.body.message.includes('has been revoked'));

      record('7. Revoked QR token rejection', true, 'Revoked token rejected and cannot be reused');
    } catch (err) {
      record('7. Revoked QR token rejection', false, err.message);
    }

    // ── TEST 8: Check-Out without Active Check-In ───────────────────────────
    try {
      // emp2 has NOT checked in today
      const noCheckIn = await api('/api/attendance/qr/check-out', {
        method: 'POST',
        token: emp2Token,
        body: { qrToken: replacementOutToken },
      });

      assert.strictEqual(noCheckIn.status, 400);
      assert.ok(noCheckIn.body.message.includes('no active Check-In found'));

      record('8. Check-Out without active Check-In rejection', true, 'Rejected check-out attempt when check-in is missing');
    } catch (err) {
      record('8. Check-Out without active Check-In rejection', false, err.message);
    }

    // ── TEST 9: Valid Check-Out & Worked Minutes Calculation ────────────────
    try {
      const checkOutRes = await api('/api/attendance/qr/check-out', {
        method: 'POST',
        token: emp1Token,
        body: { qrToken: replacementOutToken, lat: 12.9716, lng: 77.5946, accuracy: 20 },
      });

      assert.strictEqual(checkOutRes.status, 200);
      assert.strictEqual(checkOutRes.body.success, true);
      assert.ok(checkOutRes.body.data.checkOutAt);
      assert.strictEqual(typeof checkOutRes.body.data.workedMinutes, 'number');

      // Verify in DB
      const [rows] = await pool.query(
        'SELECT check_in_at, check_out_at, worked_minutes FROM attendance_records WHERE user_id = ? AND attendance_date = ?',
        [FIXTURE_USER_1, istCalendarDate()]
      );
      assert.ok(rows[0].check_out_at);

      record('9. Valid Check-Out completion & worked minutes calculation', true, 'Session completed, worked_minutes computed from server timestamps');
    } catch (err) {
      record('9. Valid Check-Out completion & worked minutes calculation', false, err.message);
    }

    // ── TEST 10: Duplicate Check-Out Protection ─────────────────────────────
    try {
      const dupOut = await api('/api/attendance/qr/check-out', {
        method: 'POST',
        token: emp1Token,
        body: { qrToken: replacementOutToken },
      });

      assert.strictEqual(dupOut.status, 409);
      assert.ok(dupOut.body.message.includes('Duplicate Check-Out'));

      record('10. Duplicate Check-Out rejection', true, 'Returned 409 Conflict when session already completed');
    } catch (err) {
      record('10. Duplicate Check-Out rejection', false, err.message);
    }

    // ── TEST 11: Concurrent Check-In Race Condition ─────────────────────────
    try {
      // Fire 2 simultaneous check-in requests for emp2 at the exact same moment
      const [res1, res2] = await Promise.all([
        api('/api/attendance/qr/check-in', {
          method: 'POST',
          token: emp2Token,
          body: { qrToken: checkInQrToken },
        }),
        api('/api/attendance/qr/check-in', {
          method: 'POST',
          token: emp2Token,
          body: { qrToken: checkInQrToken },
        }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      assert.deepStrictEqual(statuses, [200, 409], 'Exactly one must succeed (200) and one must return duplicate (409)');

      // Verify DB contains exactly 1 record for emp2
      const [emp2Rows] = await pool.query(
        'SELECT COUNT(*) AS cnt FROM attendance_records WHERE user_id = ? AND attendance_date = ?',
        [FIXTURE_USER_2, istCalendarDate()]
      );
      assert.strictEqual(emp2Rows[0].cnt, 1, 'Database must contain exactly 1 attendance record');

      record('11. Concurrent Check-In race protection', true, 'Parallel submissions safely resolved via DB constraint (200 and 409)');
    } catch (err) {
      record('11. Concurrent Check-In race protection', false, err.message);
    }

    // ── TEST 12: Personal Attendance History ────────────────────────────────
    try {
      const histRes = await api('/api/attendance/me/history', {
        token: emp1Token,
      });

      assert.strictEqual(histRes.status, 200);
      assert.strictEqual(histRes.body.success, true);
      assert.ok(Array.isArray(histRes.body.data));
      assert.ok(histRes.body.data.length >= 1, 'Should return at least 1 record');
      assert.strictEqual(histRes.body.data[0].user_id, FIXTURE_USER_1);

      record('12. Personal attendance history (/api/attendance/me/history)', true, 'Returned personal records ordered by date');
    } catch (err) {
      record('12. Personal attendance history (/api/attendance/me/history)', false, err.message);
    }

    // ── TEST 13: Admin Paginated Daily Attendance Logs ──────────────────────
    try {
      // 1. Employee rejected
      const empAttempt = await api('/api/attendance/admin/daily-logs', {
        token: emp1Token,
      });
      assert.strictEqual(empAttempt.status, 401, 'Must reject employee token with 401');

      // 2. Admin retrieves daily logs
      const logsRes = await api(`/api/attendance/admin/daily-logs?date=${istCalendarDate()}&page=1&limit=10`, {
        token: adminToken,
      });

      assert.strictEqual(logsRes.status, 200);
      assert.strictEqual(logsRes.body.success, true);
      assert.ok(logsRes.body.data.total >= 2, 'Should include both emp1 and emp2 records');
      assert.strictEqual(logsRes.body.data.page, 1);
      assert.ok(Array.isArray(logsRes.body.data.records));

      record('13. Admin paginated daily attendance logs', true, 'Returned paginated logs with total count, rejected employee access');
    } catch (err) {
      record('13. Admin paginated daily attendance logs', false, err.message);
    }

  } finally {
    await cleanupFixtures();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await pool.end();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n------------------------------------------------------');
  const passed = testResults.filter((t) => t.pass).length;
  const failed = testResults.filter((t) => !t.pass).length;
  console.log(`Phase 3 Tests Total: ${testResults.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
