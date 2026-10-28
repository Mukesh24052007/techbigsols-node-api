'use strict';

/**
 * scripts/test-phase4-onboarding.js
 * Acceptance Test Suite for Attendance 2.0 Phase 4 — Employee Onboarding:
 *
 * 1.  First employee receives TBS001 when sequence is empty.
 * 2.  Next employee receives TBS002.
 * 3.  Existing legacy tbusr… accounts remain intact.
 * 4.  Existing TBS IDs and sequence state are reconciled safely.
 * 5.  Concurrent employee creation never produces duplicate IDs.
 * 6.  Duplicate email is rejected.
 * 7.  Email uniqueness handles case differences consistently.
 * 8.  Newly created employees receive must_change_password = 1.
 * 9.  Existing employees with the flag set to 0 are not unexpectedly blocked.
 * 10. First-login response communicates the mandatory password-change state.
 * 11. Correct current password permits password change.
 * 12. Incorrect current password is rejected.
 * 13. Successful password change clears the flag.
 * 14. Employee APIs remain blocked while a mandatory password change is pending.
 * 15. Employee cannot change another user's password.
 * 16. Admin authentication and existing employee authentication remain functional.
 * 17. Attendance QR endpoints and personal history continue working.
 * 18. Migration idempotency and regression tests pass.
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
const { migrate } = require('../src/config/migrate');
const SiteUserModel = require('../src/models/siteUser.model');
const QrSessionService = require('../src/services/qrSessionService');
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
function record(num, name, pass, detail) {
  testResults.push({ num, name, pass, detail });
  const icon = pass ? '✅' : '❌';
  console.log(`${icon} Test ${num}: ${name}${detail ? ` — ${detail}` : ''}`);
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

// Generate an admin token for User Master testing
function signAdminToken(adminId, email = 'admin.p4@techbigsolutions.in') {
  return jwt.sign(
    { id: adminId, email, role: 'admin' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// Generate a site-user token
function signSiteUserToken(userId, email) {
  return jwt.sign(
    { userId, email, type: 'site_user' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

async function runPhase4Tests() {
  console.log('\n======================================================');
  console.log('  ATTENDANCE 2.0 — PHASE 4 ONBOARDING ACCEPTANCE SUITE');
  console.log('======================================================\n');

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
     VALUES ('Phase4 Admin', 'p4.admin@techbigsolutions.in', ?, 'admin', 1)
     ON DUPLICATE KEY UPDATE name = 'Phase4 Admin'`,
    [hashedAdminPw]
  );
  if (adminInsert.insertId) {
    FIXTURE_ADMIN_ID = adminInsert.insertId;
  } else {
    const [rows] = await pool.query("SELECT id FROM admins WHERE email = 'p4.admin@techbigsolutions.in'");
    FIXTURE_ADMIN_ID = rows[0]?.id;
  }
  adminToken = signAdminToken(FIXTURE_ADMIN_ID, 'p4.admin@techbigsolutions.in');

  // Track created test users for cleanup
  const createdTestUsers = [];

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // Test 1: First employee receives TBS001 when sequence is empty
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Temporarily ensure sequence and no TBS users exist for Test 1
      const [existingTbs] = await pool.query("SELECT user_id FROM site_users WHERE user_id REGEXP '^TBS[0-9]+'");
      if (existingTbs.length === 0) {
        await pool.query("UPDATE app_sequences SET current_val = 0 WHERE sequence_name = 'employee_id'");
      }

      const res = await api('/api/user-master', {
        method: 'POST',
        token: adminToken,
        body: {
          fullname: 'First Onboarded Employee',
          email: 'first.onboard@techbigsolutions.in',
          password: 'InitialPassword123!',
          moduleAccess: ['Attendance'],
          role: 'employee',
          phone: '9876543210',
          department: 'Engineering',
          designation: 'Software Engineer',
        },
      });

      assert.strictEqual(res.status, 201, `Expected 201 Created, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.userId, 'TBS001', `Expected TBS001, got ${res.body.data.userId}`);
      createdTestUsers.push(res.body.data.userId);

      record(1, 'First employee receives TBS001 when sequence is empty', true, `Allocated ${res.body.data.userId}`);
    } catch (err) {
      record(1, 'First employee receives TBS001 when sequence is empty', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 2: Next employee receives TBS002
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const res = await api('/api/user-master', {
        method: 'POST',
        token: adminToken,
        body: {
          fullname: 'Second Onboarded Employee',
          email: 'second.onboard@techbigsolutions.in',
          password: 'InitialPassword123!',
          moduleAccess: ['Attendance'],
          role: 'employee',
          phone: '9876543211',
          department: 'Product',
          designation: 'QA Analyst',
        },
      });

      assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}`);
      assert.strictEqual(res.body.data.userId, 'TBS002', `Expected TBS002, got ${res.body.data.userId}`);
      createdTestUsers.push(res.body.data.userId);

      record(2, 'Next employee receives TBS002', true, `Allocated ${res.body.data.userId}`);
    } catch (err) {
      record(2, 'Next employee receives TBS002', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 3: Existing legacy tbusr… accounts remain intact
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const [legacyUsers] = await pool.query(
        "SELECT user_id, email, is_active FROM site_users WHERE user_id LIKE 'tbusr%' ORDER BY user_id ASC"
      );
      assert.ok(legacyUsers.length >= 2, 'Expected legacy tbusr accounts to be present');
      const sample = legacyUsers[0];
      assert.ok(sample.user_id.startsWith('tbusr'), `User ID ${sample.user_id} should start with tbusr`);

      // Verify legacy user can be retrieved through User Master API
      const res = await api(`/api/user-master/${sample.user_id}`, {
        method: 'GET',
        token: adminToken,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.userId || res.body.data.user_id, sample.user_id);
      assert.strictEqual(res.body.data.email, sample.email);

      record(3, 'Existing legacy tbusr… accounts remain intact', true, `Verified ${legacyUsers.length} legacy accounts`);
    } catch (err) {
      record(3, 'Existing legacy tbusr… accounts remain intact', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 4: Existing TBS IDs and sequence state are reconciled safely
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Manually simulate an existing higher TBS ID (e.g. TBS010) while sequence is lower
      const dummyHashedPw = await bcrypt.hash('TempPass123!', 10);
      await pool.query(
        `INSERT INTO site_users (user_id, fullname, email, password, module_access, is_active, must_change_password)
         VALUES ('TBS010', 'Reconciliation Test User', 'reconcile.test@techbigsolutions.in', ?, '["Attendance"]', 1, 1)`,
        [dummyHashedPw]
      );
      createdTestUsers.push('TBS010');

      // Now set sequence lower (e.g. at 2)
      await pool.query("UPDATE app_sequences SET current_val = 2 WHERE sequence_name = 'employee_id'");

      // Next creation must detect TBS010 and allocate TBS011, NOT TBS003
      const res = await api('/api/user-master', {
        method: 'POST',
        token: adminToken,
        body: {
          fullname: 'Post Reconcile Employee',
          email: 'post.reconcile@techbigsolutions.in',
          password: 'InitialPassword123!',
          moduleAccess: ['Attendance'],
        },
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.userId, 'TBS011', `Expected TBS011 after reconciliation, got ${res.body.data.userId}`);
      createdTestUsers.push(res.body.data.userId);

      // Verify sequence value in DB is now 11
      const [seq] = await pool.query("SELECT current_val FROM app_sequences WHERE sequence_name = 'employee_id'");
      assert.strictEqual(Number(seq[0].current_val), 11);

      record(4, 'Existing TBS IDs and sequence state are reconciled safely', true, 'Detected TBS010 and safely allocated TBS011');
    } catch (err) {
      record(4, 'Existing TBS IDs and sequence state are reconciled safely', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 5: Concurrent employee creation never produces duplicate IDs
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const concurrencyCount = 5;
      const promises = [];

      for (let i = 1; i <= concurrencyCount; i++) {
        promises.push(
          api('/api/user-master', {
            method: 'POST',
            token: adminToken,
            body: {
              fullname: `Concurrent Employee ${i}`,
              email: `concurrent.${i}.${Date.now()}@techbigsolutions.in`,
              password: 'InitialPassword123!',
              moduleAccess: ['Attendance'],
            },
          })
        );
      }

      const results = await Promise.all(promises);
      const allocatedIds = [];

      for (const res of results) {
        assert.strictEqual(res.status, 201, `Concurrent creation failed with status ${res.status}: ${JSON.stringify(res.body)}`);
        assert.ok(res.body.data.userId.startsWith('TBS'), `ID should start with TBS: ${res.body.data.userId}`);
        allocatedIds.push(res.body.data.userId);
        createdTestUsers.push(res.body.data.userId);
      }

      // Check all allocated IDs are distinct
      const uniqueIds = new Set(allocatedIds);
      assert.strictEqual(uniqueIds.size, concurrencyCount, `Duplicate IDs detected in concurrent run: ${allocatedIds.join(', ')}`);

      record(5, 'Concurrent employee creation never produces duplicate IDs', true, `Allocated distinct IDs: ${allocatedIds.join(', ')}`);
    } catch (err) {
      record(5, 'Concurrent employee creation never produces duplicate IDs', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 6: Duplicate email is rejected
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const res = await api('/api/user-master', {
        method: 'POST',
        token: adminToken,
        body: {
          fullname: 'Duplicate Email Person',
          email: 'first.onboard@techbigsolutions.in', // Already used in Test 1
          password: 'InitialPassword123!',
          moduleAccess: ['Attendance'],
        },
      });

      assert.strictEqual(res.status, 409, `Expected 409 Conflict, got ${res.status}`);
      assert.strictEqual(res.body.success, false);
      assert.ok(res.body.message.includes('already exists'));

      record(6, 'Duplicate email is rejected', true, `Rejected with 409: "${res.body.message}"`);
    } catch (err) {
      record(6, 'Duplicate email is rejected', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 7: Email uniqueness handles case differences consistently
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const res = await api('/api/user-master', {
        method: 'POST',
        token: adminToken,
        body: {
          fullname: 'Uppercase Email Person',
          email: 'FIRST.ONBOARD@TECHBIGSOLUTIONS.IN', // Uppercase variation
          password: 'InitialPassword123!',
          moduleAccess: ['Attendance'],
        },
      });

      assert.strictEqual(res.status, 409, `Expected 409 Conflict for case-variant email, got ${res.status}`);
      assert.strictEqual(res.body.success, false);

      record(7, 'Email uniqueness handles case differences consistently', true, 'Case-variant email rejected with 409');
    } catch (err) {
      record(7, 'Email uniqueness handles case differences consistently', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 8: Newly created employees receive must_change_password = 1
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const res = await api('/api/user-master', {
        method: 'POST',
        token: adminToken,
        body: {
          fullname: 'Password Policy Test User',
          email: 'pw.test@techbigsolutions.in',
          password: 'TempPassword123!',
          moduleAccess: ['Attendance'],
        },
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.mustChangePassword, true);
      const testUserId = res.body.data.userId;
      createdTestUsers.push(testUserId);

      // Directly verify in database table
      const [rows] = await pool.query('SELECT must_change_password FROM site_users WHERE user_id = ?', [testUserId]);
      assert.strictEqual(Number(rows[0].must_change_password), 1);

      record(8, 'Newly created employees receive must_change_password = 1', true, `DB column must_change_password is 1`);
    } catch (err) {
      record(8, 'Newly created employees receive must_change_password = 1', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 9: Existing employees with flag set to 0 are not unexpectedly blocked
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Find a legacy employee with must_change_password = 0
      const [legacy] = await pool.query("SELECT user_id, email FROM site_users WHERE must_change_password = 0 AND is_active = 1 LIMIT 1");
      assert.ok(legacy.length > 0, 'No active legacy employee with must_change_password = 0 found');

      const legacyToken = signSiteUserToken(legacy[0].user_id, legacy[0].email);

      // Access protected employee endpoint (/api/site-auth/me)
      const meRes = await api('/api/site-auth/me', {
        method: 'GET',
        token: legacyToken,
      });
      assert.strictEqual(meRes.status, 200);
      assert.strictEqual(meRes.body.user.mustChangePassword, false);

      // Access employee attendance history (/api/attendance/me/history)
      const histRes = await api('/api/attendance/me/history', {
        method: 'GET',
        token: legacyToken,
      });
      assert.strictEqual(histRes.status, 200);

      record(9, 'Existing employees with flag set to 0 are not unexpectedly blocked', true, 'Legacy employee accessed protected APIs');
    } catch (err) {
      record(9, 'Existing employees with flag set to 0 are not unexpectedly blocked', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 10: First-login response communicates mandatory password-change state
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const loginRes = await api('/api/site-auth/login', {
        method: 'POST',
        body: {
          email: 'pw.test@techbigsolutions.in',
          password: 'TempPassword123!',
        },
      });

      assert.strictEqual(loginRes.status, 200);
      assert.strictEqual(loginRes.body.success, true);
      assert.strictEqual(loginRes.body.mustChangePassword, true);
      assert.strictEqual(loginRes.body.user.mustChangePassword, true);
      assert.ok(loginRes.body.token, 'Token should be returned');
      assert.ok(loginRes.body.message.includes('must change your password'));

      record(10, 'First-login response communicates mandatory password-change state', true, `mustChangePassword=true in response payload`);
    } catch (err) {
      record(10, 'First-login response communicates mandatory password-change state', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 11: Correct current password permits password change
    // ──────────────────────────────────────────────────────────────────────────
    let onboardedUserToken = '';
    try {
      // Login to get token for pw.test user
      const loginRes = await api('/api/site-auth/login', {
        method: 'POST',
        body: {
          email: 'pw.test@techbigsolutions.in',
          password: 'TempPassword123!',
        },
      });
      onboardedUserToken = loginRes.body.token;

      // Call change password with correct current password and valid new password
      const changeRes = await api('/api/site-auth/change-password', {
        method: 'POST',
        token: onboardedUserToken,
        body: {
          currentPassword: 'TempPassword123!',
          newPassword: 'BrandNewSecurePassword@2026',
        },
      });

      assert.strictEqual(changeRes.status, 200, `Expected 200 OK, got ${changeRes.status}: ${JSON.stringify(changeRes.body)}`);
      assert.strictEqual(changeRes.body.success, true);

      record(11, 'Correct current password permits password change', true, 'Password changed successfully');
    } catch (err) {
      record(11, 'Correct current password permits password change', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 12: Incorrect current password is rejected
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Create another fresh user to test wrong password rejection
      const setupRes = await api('/api/user-master', {
        method: 'POST',
        token: adminToken,
        body: {
          fullname: 'Wrong PW Test User',
          email: 'wrong.pw@techbigsolutions.in',
          password: 'SecretInitial123!',
          moduleAccess: ['Attendance'],
        },
      });
      createdTestUsers.push(setupRes.body.data.userId);

      const loginRes = await api('/api/site-auth/login', {
        method: 'POST',
        body: {
          email: 'wrong.pw@techbigsolutions.in',
          password: 'SecretInitial123!',
        },
      });
      const token = loginRes.body.token;

      const changeRes = await api('/api/site-auth/change-password', {
        method: 'POST',
        token,
        body: {
          currentPassword: 'IncorrectPassword999!',
          newPassword: 'BrandNewSecurePassword@2026',
        },
      });

      assert.strictEqual(changeRes.status, 400);
      assert.strictEqual(changeRes.body.success, false);
      assert.ok(changeRes.body.message.includes('Invalid current password'));

      record(12, 'Incorrect current password is rejected', true, `Rejected with 400: "${changeRes.body.message}"`);
    } catch (err) {
      record(12, 'Incorrect current password is rejected', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 13: Successful password change clears the flag
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Check pw.test user (from Test 11): must_change_password in DB should be 0
      const [rows] = await pool.query("SELECT must_change_password FROM site_users WHERE email = 'pw.test@techbigsolutions.in'");
      assert.strictEqual(Number(rows[0].must_change_password), 0, 'DB must_change_password should be 0');

      // Login with the new password
      const newLoginRes = await api('/api/site-auth/login', {
        method: 'POST',
        body: {
          email: 'pw.test@techbigsolutions.in',
          password: 'BrandNewSecurePassword@2026',
        },
      });

      assert.strictEqual(newLoginRes.status, 200);
      assert.strictEqual(newLoginRes.body.mustChangePassword, false);
      assert.strictEqual(newLoginRes.body.user.mustChangePassword, false);

      record(13, 'Successful password change clears the flag', true, 'DB flag cleared and new login reports mustChangePassword=false');
    } catch (err) {
      record(13, 'Successful password change clears the flag', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 14: Employee APIs remain blocked while mandatory password change pending
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Create an employee with must_change_password = 1
      const setupRes = await api('/api/user-master', {
        method: 'POST',
        token: adminToken,
        body: {
          fullname: 'Blocked Until PW Change',
          email: 'blocked.until.pw@techbigsolutions.in',
          password: 'InitialPassword123!',
          moduleAccess: ['Attendance'],
        },
      });
      createdTestUsers.push(setupRes.body.data.userId);

      const loginRes = await api('/api/site-auth/login', {
        method: 'POST',
        body: {
          email: 'blocked.until.pw@techbigsolutions.in',
          password: 'InitialPassword123!',
        },
      });
      const pendingToken = loginRes.body.token;

      // Attempt to access /api/attendance/me/history
      const histRes = await api('/api/attendance/me/history', {
        method: 'GET',
        token: pendingToken,
      });

      assert.strictEqual(histRes.status, 403, `Expected 403 Forbidden, got ${histRes.status}`);
      assert.strictEqual(histRes.body.code, 'PASSWORD_CHANGE_REQUIRED');

      // Attempt to access /api/attendance/qr/check-in
      const checkInRes = await api('/api/attendance/qr/check-in', {
        method: 'POST',
        token: pendingToken,
        body: {
          qrToken: 'any_dummy_token',
        },
      });

      assert.strictEqual(checkInRes.status, 403, `Expected 403 Forbidden, got ${checkInRes.status}`);
      assert.strictEqual(checkInRes.body.code, 'PASSWORD_CHANGE_REQUIRED');

      record(14, 'Employee APIs remain blocked while mandatory password change pending', true, 'Blocked with 403 PASSWORD_CHANGE_REQUIRED');
    } catch (err) {
      record(14, 'Employee APIs remain blocked while mandatory password change pending', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 15: Employee cannot change another user's password
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Attacker is wrong.pw user. Attempts to send userId or email of pw.test in the body
      const attackerLogin = await api('/api/site-auth/login', {
        method: 'POST',
        body: {
          email: 'wrong.pw@techbigsolutions.in',
          password: 'SecretInitial123!',
        },
      });
      const attackerToken = attackerLogin.body.token;

      // Attacker attempts to provide target's email/userId in body
      const spoofRes = await api('/api/site-auth/change-password', {
        method: 'POST',
        token: attackerToken,
        body: {
          currentPassword: 'SecretInitial123!', // Attacker's own password
          newPassword: 'HackedPassword@2026',
          userId: 'TBS001',
          email: 'first.onboard@techbigsolutions.in',
        },
      });

      assert.strictEqual(spoofRes.status, 200);

      // Verify that the TARGET user's password was NOT changed
      const targetCheck = await api('/api/site-auth/login', {
        method: 'POST',
        body: {
          email: 'first.onboard@techbigsolutions.in',
          password: 'InitialPassword123!', // Original password must still work
        },
      });
      assert.strictEqual(targetCheck.status, 200, 'Target user password was untouched');

      // Verify attacker's own password WAS the one changed
      const attackerCheck = await api('/api/site-auth/login', {
        method: 'POST',
        body: {
          email: 'wrong.pw@techbigsolutions.in',
          password: 'HackedPassword@2026',
        },
      });
      assert.strictEqual(attackerCheck.status, 200, 'Attacker changed only their own password');

      record(15, "Employee cannot change another user's password", true, 'Identity strictly derived from JWT session');
    } catch (err) {
      record(15, "Employee cannot change another user's password", false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 16: Admin authentication and existing employee authentication remain functional
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // 1. Admin auth works
      const adminRes = await api('/api/user-master', {
        method: 'GET',
        token: adminToken,
      });
      assert.strictEqual(adminRes.status, 200);
      assert.strictEqual(adminRes.body.success, true);

      // 2. Legacy employee auth works
      const [legacyUser] = await pool.query("SELECT email FROM site_users WHERE user_id = 'tbusr001'");
      assert.ok(legacyUser.length > 0);
      const legacyLogin = await api('/api/site-auth/login', {
        method: 'POST',
        body: {
          email: legacyUser[0].email,
          password: 'password123', // Standard legacy employee password in local db
        },
      });
      assert.strictEqual(legacyLogin.status, 200);
      assert.strictEqual(legacyLogin.body.user.userId, 'tbusr001');

      record(16, 'Admin and legacy employee authentication remain functional', true, 'Both systems operational');
    } catch (err) {
      record(16, 'Admin and legacy employee authentication remain functional', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 17: Attendance QR endpoints and personal history continue working
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Login with onboarded user whose password has been changed (pw.test)
      const userLogin = await api('/api/site-auth/login', {
        method: 'POST',
        body: {
          email: 'pw.test@techbigsolutions.in',
          password: 'BrandNewSecurePassword@2026',
        },
      });
      const validEmpToken = userLogin.body.token;

      // 1. Admin generates an active CHECK_IN QR
      const testOfficeId = 9991;
      await pool.query('DELETE FROM attendance_qr_sessions WHERE office_id = ?', [testOfficeId]);
      const qrGenRes = await api('/api/attendance/admin/qr/generate', {
        method: 'POST',
        token: adminToken,
        body: {
          officeId: testOfficeId,
          action: 'CHECK_IN',
        },
      });
      assert.ok(qrGenRes.status === 200 || qrGenRes.status === 201, `QR gen status: ${qrGenRes.status}`);
      const rawQrToken = qrGenRes.body.data.qrToken;
      assert.ok(rawQrToken, 'Admin QR token received');

      // 2. Employee checks in with the QR token
      const checkInRes = await api('/api/attendance/qr/check-in', {
        method: 'POST',
        token: validEmpToken,
        body: {
          qrToken: rawQrToken,
          lat: 13.0827,
          lng: 80.2707,
          accuracy: 10,
        },
      });
      // Accept either 200 OK or 409 if already checked in today
      assert.ok(
        checkInRes.status === 200 || (checkInRes.status === 409 && checkInRes.body.message.includes('already checked in')),
        `Unexpected check-in status: ${checkInRes.status} ${JSON.stringify(checkInRes.body)}`
      );

      // 3. Employee fetches personal attendance history
      const histRes = await api('/api/attendance/me/history', {
        method: 'GET',
        token: validEmpToken,
      });
      assert.strictEqual(histRes.status, 200);
      assert.ok(Array.isArray(histRes.body.data), 'History should be an array');

      record(17, 'Attendance QR endpoints and personal history continue working', true, 'Onboarded employee check-in and history verified');
    } catch (err) {
      record(17, 'Attendance QR endpoints and personal history continue working', false, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 18: Migration idempotency and regression tests pass
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // 1. Run migrate() to verify idempotency
      await migrate();

      // 2. Verify QR encryption key enforcement: when NODE_ENV is production, missing key throws
      const origEnv = process.env.NODE_ENV;
      const origKey = process.env.QR_ENC_KEY;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.QR_ENC_KEY;
        assert.throws(
          () => {
            QrSessionService.getEncryptionKey();
          },
          /QR_ENC_KEY environment variable is strictly required in production/,
          'Should throw in production without QR_ENC_KEY'
        );
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origKey) process.env.QR_ENC_KEY = origKey;
      }

      record(18, 'Migration idempotency and regression tests pass', true, 'Migration re-run passed and production QR_ENC_KEY safety verified');
    } catch (err) {
      record(18, 'Migration idempotency and regression tests pass', false, err.message);
    }

  } finally {
    // Cleanup created test users and admin
    try {
      if (createdTestUsers.length > 0) {
        await pool.query('DELETE FROM attendance_records WHERE user_id IN (?)', [createdTestUsers]);
        await pool.query('DELETE FROM site_users WHERE user_id IN (?)', [createdTestUsers]);
      }
      if (FIXTURE_ADMIN_ID) {
        await pool.query('DELETE FROM admins WHERE id = ?', [FIXTURE_ADMIN_ID]);
      }
    } catch (cleanupErr) {
      console.warn('⚠️  Cleanup error:', cleanupErr.message);
    }

    if (server) {
      server.close();
    }
  }

  // Summary
  console.log('\n======================================================');
  console.log('  TEST SUMMARY');
  console.log('======================================================');
  const passed = testResults.filter((r) => r.pass).length;
  const failed = testResults.filter((r) => !r.pass).length;
  console.log(`Total: ${testResults.length} | Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    console.error(`\n❌ ${failed} test(s) failed.`);
    process.exit(1);
  } else {
    console.log('\n🎉 ALL 18 PHASE 4 ACCEPTANCE TESTS PASSED!\n');
    process.exit(0);
  }
}

runPhase4Tests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
