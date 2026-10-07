/**
 * scripts/test-phase2.js
 * Acceptance test suite for Step B (Attendance Employee API + Face Enrolment).
 *
 * Rules:
 * - Refuses to run unless DB_HOST is localhost or 127.0.0.1 and NODE_ENV is not production.
 * - Uses fixture ids that sort below real ids (e.g. tbtst001, tbtst002).
 * - Starts Express on a free port in-process.
 * - Cleans up only fixture rows in a finally block.
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
const AttendancePresenceModel = require('../src/models/attendancePresence.model');
const { toUtcDateTime, istCalendarDate } = require('../src/utils/time');
const { recordAttempt } = require('../src/services/attendanceGate');

// ── Environment Guard ────────────────────────────────────────────────────────
const dbHost = process.env.DB_HOST || 'localhost';
const isLocalDb = dbHost === 'localhost' || dbHost === '127.0.0.1';
const isDev = process.env.NODE_ENV !== 'production';

if (!isLocalDb || !isDev) {
  console.error('❌ Refusing to run tests: DB_HOST must be localhost/127.0.0.1 and NODE_ENV must not be production.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

// Test fixtures (sort below 'tbusr...')
const FIXTURE_USER_1 = 'tbtst001'; // Employee with Attendance module
const FIXTURE_USER_2 = 'tbtst002'; // Employee without Attendance module
const FIXTURE_USER_OTHER = 'tbtst003'; // Another employee for face mismatch test
let FIXTURE_ADMIN_ID = null;
let FIXTURE_OFFICE_ID = null;

let server = null;
let baseUrl = '';

// Helper to make requests to our in-process test server
async function api(path, { method = 'GET', token = null, body = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = { raw: text };
  }
  return { status: res.status, headers: res.headers, body: json };
}

// Generate synthetic face descriptors
function generateDescriptor(seed = 1) {
  const arr = new Array(128);
  for (let i = 0; i < 128; i++) {
    arr[i] = Math.sin(seed * (i + 1) * 0.1) * 0.1;
  }
  return arr;
}

function noisyCopy(base, noiseAmp = 0.005, frame = 1) {
  return base.map((v, i) => v + Math.sin((frame + 1) * (i + 1)) * noiseAmp);
}

// Office coordinates (Bangalore MG Road area)
const OFFICE_LAT = 12.9715987;
const OFFICE_LNG = 77.5945627;
const OFFICE_RADIUS = 150;

async function runTests() {
  console.log('🧪 Starting Step B Attendance Acceptance Tests...\n');
  const results = [];

  function record(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const mark = passed ? '✅' : '❌';
    console.log(`${mark} ${name}${detail ? ` (${detail})` : ''}`);
  }

  try {
    // ── 1. Start Server on random port ──────────────────────────────────────
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;

    // ── 2. Create DB Fixtures ───────────────────────────────────────────────
    const hashedPassword = await bcrypt.hash('Password123!', 4);
    const now = toUtcDateTime();

    // Fixture Admin
    const [adminResult] = await pool.query(
      `INSERT INTO admins (name, email, password, role, is_active, created_at)
       VALUES ('Fixture Admin', 'fixture_admin@techbigsols.com', ?, 'admin', 1, ?)`,
      [hashedPassword, now]
    );
    FIXTURE_ADMIN_ID = adminResult.insertId;

    // Fixture Site User 1 (Attendance enabled)
    await pool.query(
      `INSERT INTO site_users (user_id, fullname, email, password, module_access, is_active, created_at)
       VALUES (?, 'Test User 1', 'test_user1@techbigsols.com', ?, ?, 1, ?)`,
      [FIXTURE_USER_1, hashedPassword, JSON.stringify(['Attendance']), now]
    );

    // Fixture Site User 2 (No Attendance module)
    await pool.query(
      `INSERT INTO site_users (user_id, fullname, email, password, module_access, is_active, created_at)
       VALUES (?, 'Test User 2', 'test_user2@techbigsols.com', ?, ?, 1, ?)`,
      [FIXTURE_USER_2, hashedPassword, JSON.stringify(['Products']), now]
    );

    // Fixture Site User 3 (For face mismatch)
    await pool.query(
      `INSERT INTO site_users (user_id, fullname, email, password, module_access, is_active, created_at)
       VALUES (?, 'Test User 3', 'test_user3@techbigsols.com', ?, ?, 1, ?)`,
      [FIXTURE_USER_OTHER, hashedPassword, JSON.stringify(['Attendance']), now]
    );

    // Fixture Office
    const [officeResult] = await pool.query(
      `INSERT INTO attendance_offices
        (name, lat, lng, radius_m, accuracy_max_m, shift_start, shift_end, grace_minutes,
         outside_tolerance_minutes, heartbeat_seconds, reverify_count, created_at, updated_at)
       VALUES ('Fixture Test Office', ?, ?, ?, 50, '09:00:00', '19:00:00', 10, 10, 60, 2, ?, ?)`,
      [OFFICE_LAT, OFFICE_LNG, OFFICE_RADIUS, now, now]
    );
    FIXTURE_OFFICE_ID = officeResult.insertId;

    // Profiles for User 1 & User 3
    await pool.query(
      `INSERT INTO attendance_profiles (user_id, office_id, created_at, updated_at)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      [FIXTURE_USER_1, FIXTURE_OFFICE_ID, now, now, FIXTURE_USER_OTHER, FIXTURE_OFFICE_ID, now, now]
    );

    // Issue JWTs
    const makeEmployeeToken = (id) => jwt.sign({ userId: id, type: 'site_user' }, JWT_SECRET, { expiresIn: '1h' });
    const tokenEmployee1 = makeEmployeeToken(FIXTURE_USER_1);
    const tokenEmployee2 = makeEmployeeToken(FIXTURE_USER_2);
    const tokenAdmin = jwt.sign({ id: FIXTURE_ADMIN_ID, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });

    // Descriptors setup
    const faceUser1 = generateDescriptor(1);
    const faceUserOther = generateDescriptor(99); // completely different face

    // ── Test Cases ──────────────────────────────────────────────────────────

    // Test 1: Missing Attendance module -> 403
    {
      const res = await api('/api/attendance/me/status', { token: tokenEmployee2 });
      record('User without Attendance module returns 403', res.status === 403);
    }

    // Test 2: Admin token on employee route -> 401/403
    {
      const res = await api('/api/attendance/me/status', { token: tokenAdmin });
      record('Admin token rejected on employee route (401/403)', res.status === 401 || res.status === 403);
    }

    // Test 3: Employee token on admin route -> 401/403
    {
      const res = await api(`/api/attendance/admin/employees/${FIXTURE_USER_1}/face`, {
        method: 'POST',
        token: tokenEmployee1,
        body: { descriptors: [faceUser1, faceUser1, faceUser1, faceUser1, faceUser1] },
      });
      record('Employee token rejected on admin route (401/403)', res.status === 401 || res.status === 403);
    }

    // Test 4: Missing consent returns 403
    {
      // 4a. Challenge without consent -> 403
      const resChallenge = await api('/api/attendance/challenge', {
        method: 'POST',
        token: tokenEmployee1,
        body: { purpose: 'checkin', lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 10 },
      });
      record('Challenge without employee consent returns 403', resChallenge.status === 403);

      // 4b. Admin face enrolment without consent -> 403
      const resEnrol = await api(`/api/attendance/admin/employees/${FIXTURE_USER_1}/face`, {
        method: 'POST',
        token: tokenAdmin,
        body: {
          descriptors: [
            faceUser1,
            noisyCopy(faceUser1, 0.005, 1),
            noisyCopy(faceUser1, 0.005, 2),
            noisyCopy(faceUser1, 0.005, 3),
            noisyCopy(faceUser1, 0.005, 4),
          ],
        },
      });
      record('Admin face enrolment without employee consent returns 403', resEnrol.status === 403);
    }

    // Test 5: Record consent successfully
    {
      const res = await api('/api/attendance/me/consent', {
        method: 'POST',
        token: tokenEmployee1,
        body: { version: '1.0' },
      });
      record('Record consent returns 200', res.status === 200 && res.body?.success === true);

      // Also set consent for User 3
      await api('/api/attendance/me/consent', {
        method: 'POST',
        token: makeEmployeeToken(FIXTURE_USER_OTHER),
        body: { version: '1.0' },
      });
    }

    // Test 6: Admin face enrolment with highly divergent descriptors -> 400
    {
      const divergentDescriptors = [
        faceUser1,
        generateDescriptor(10),
        generateDescriptor(20),
        generateDescriptor(30),
        generateDescriptor(40),
      ];
      const res = await api(`/api/attendance/admin/employees/${FIXTURE_USER_1}/face`, {
        method: 'POST',
        token: tokenAdmin,
        body: { descriptors: divergentDescriptors },
      });
      record('Enrolment with divergent descriptors returns 400', res.status === 400);
    }

    // Test 7: Admin face enrolment with valid 5 descriptors -> 200
    {
      const validEnrolment = [
        faceUser1,
        noisyCopy(faceUser1, 0.005, 1),
        noisyCopy(faceUser1, 0.005, 2),
        noisyCopy(faceUser1, 0.005, 3),
        noisyCopy(faceUser1, 0.005, 4),
      ];
      const res = await api(`/api/attendance/admin/employees/${FIXTURE_USER_1}/face`, {
        method: 'POST',
        token: tokenAdmin,
        body: { descriptors: validEnrolment },
      });
      const noLeak = !res.body?.data?.template && !res.body?.data?.face_template;
      record('Enrolment with 5 valid descriptors succeeds (never returns embedding)', res.status === 200 && noLeak);
    }

    // Test 8: Challenge request outside radius -> 400
    {
      const res = await api('/api/attendance/challenge', {
        method: 'POST',
        token: tokenEmployee1,
        body: { purpose: 'checkin', lat: OFFICE_LAT + 0.05, lng: OFFICE_LNG + 0.05, accuracy: 10 },
      });
      record('Challenge outside radius rejected with 400', res.status === 400);
    }

    // Test 9: Challenge request with accuracy > 50m (e.g. 200m) -> 400
    {
      const res = await api('/api/attendance/challenge', {
        method: 'POST',
        token: tokenEmployee1,
        body: { purpose: 'checkin', lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 200 },
      });
      record('Challenge with poor accuracy (200m) rejected with 400', res.status === 400);
    }

    // Test 10: Valid challenge request inside radius -> 200
    let validChallengeId = null;
    {
      const res = await api('/api/attendance/challenge', {
        method: 'POST',
        token: tokenEmployee1,
        body: { purpose: 'checkin', lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 15 },
      });
      validChallengeId = res.body?.data?.challengeId;
      record('Valid challenge request returns 200 and challengeId', res.status === 200 && Boolean(validChallengeId));
    }

    // Test 11: Check-in with expired challenge -> 400
    {
      // Update challenge expiry to 10 minutes ago
      await pool.query(
        `UPDATE attendance_challenges
         SET issued_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 15 MINUTE),
             expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)
         WHERE id = ?`,
        [validChallengeId]
      );
      const res = await api('/api/attendance/check-in', {
        method: 'POST',
        token: tokenEmployee1,
        body: {
          challengeId: validChallengeId,
          descriptors: [faceUser1, noisyCopy(faceUser1, 0.005, 1), noisyCopy(faceUser1, 0.005, 2)],
          lat: OFFICE_LAT,
          lng: OFFICE_LNG,
          accuracy: 15,
        },
      });
      record('Expired challenge rejected with 400', res.status === 400);
    }

    // Test 12: Check-in with too-fast challenge (< 2s) -> 400
    {
      // Request fresh challenge
      const chalRes = await api('/api/attendance/challenge', {
        method: 'POST',
        token: tokenEmployee1,
        body: { purpose: 'checkin', lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 15 },
      });
      const fastChallengeId = chalRes.body?.data?.challengeId;

      // Set issued_at to current timestamp (0 ms elapsed)
      await pool.query(
        `UPDATE attendance_challenges SET issued_at = UTC_TIMESTAMP() WHERE id = ?`,
        [fastChallengeId]
      );

      const res = await api('/api/attendance/check-in', {
        method: 'POST',
        token: tokenEmployee1,
        body: {
          challengeId: fastChallengeId,
          descriptors: [faceUser1, noisyCopy(faceUser1, 0.005, 1), noisyCopy(faceUser1, 0.005, 2)],
          lat: OFFICE_LAT,
          lng: OFFICE_LNG,
          accuracy: 15,
        },
      });
      record('Too-fast challenge (<2s) rejected with 400', res.status === 400);
    }

    // Test 13: Identical/replayed descriptors (photo replay) -> 400
    {
      // Request fresh challenge and set issued_at to 5 seconds ago
      const chalRes = await api('/api/attendance/challenge', {
        method: 'POST',
        token: tokenEmployee1,
        body: { purpose: 'checkin', lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 15 },
      });
      const replayChalId = chalRes.body?.data?.challengeId;
      await pool.query(
        `UPDATE attendance_challenges SET issued_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 SECOND) WHERE id = ?`,
        [replayChalId]
      );

      // Send 3 identical descriptors (zero noise)
      const res = await api('/api/attendance/check-in', {
        method: 'POST',
        token: tokenEmployee1,
        body: {
          challengeId: replayChalId,
          descriptors: [faceUser1, faceUser1, faceUser1],
          lat: OFFICE_LAT,
          lng: OFFICE_LNG,
          accuracy: 15,
        },
      });

      // Check attendance_attempts to verify min_dist is logged
      const [attemptRows] = await pool.query(
        `SELECT reason FROM attendance_attempts WHERE user_id = ? AND kind = 'checkin' ORDER BY id DESC LIMIT 1`,
        [FIXTURE_USER_1]
      );
      const reasonLogsDist = attemptRows[0]?.reason?.includes('replay_detected:min_dist=');
      record('Identical descriptors rejected as replay with min_dist logged', res.status === 400 && reasonLogsDist);
    }

    // Test 14: Another person's face -> 400
    await pool.query('DELETE FROM attendance_attempts WHERE user_id = ?', [FIXTURE_USER_1]);
    {
      const chalRes = await api('/api/attendance/challenge', {
        method: 'POST',
        token: tokenEmployee1,
        body: { purpose: 'checkin', lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 15 },
      });
      const chalId = chalRes.body?.data?.challengeId;
      await pool.query(
        `UPDATE attendance_challenges SET issued_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 SECOND) WHERE id = ?`,
        [chalId]
      );

      const res = await api('/api/attendance/check-in', {
        method: 'POST',
        token: tokenEmployee1,
        body: {
          challengeId: chalId,
          descriptors: [
            faceUserOther,
            noisyCopy(faceUserOther, 0.005, 1),
            noisyCopy(faceUserOther, 0.005, 2),
          ],
          lat: OFFICE_LAT,
          lng: OFFICE_LNG,
          accuracy: 15,
        },
      });
      record("Another person's face rejected with 400", res.status === 400);

      // Verify the challenge was marked used even on face mismatch!
      const [chalRow] = await pool.query(`SELECT used_at FROM attendance_challenges WHERE id = ?`, [chalId]);
      record('Challenge consumed even when face verification fails', chalRow[0]?.used_at !== null);
    }

    // Test 15: Valid check-in inside radius with genuine face -> 200
    // Reset any failure count for User 1 before testing normal check-in flow
    await pool.query('DELETE FROM attendance_attempts WHERE user_id = ?', [FIXTURE_USER_1]);

    let checkinChallengeId = null;
    {
      const chalRes = await api('/api/attendance/challenge', {
        method: 'POST',
        token: tokenEmployee1,
        body: { purpose: 'checkin', lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 15 },
      });
      checkinChallengeId = chalRes.body?.data?.challengeId;
      await pool.query(
        `UPDATE attendance_challenges SET issued_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 SECOND) WHERE id = ?`,
        [checkinChallengeId]
      );

      const res = await api('/api/attendance/check-in', {
        method: 'POST',
        token: tokenEmployee1,
        body: {
          challengeId: checkinChallengeId,
          descriptors: [
            noisyCopy(faceUser1, 0.005, 1),
            noisyCopy(faceUser1, 0.005, 2),
            noisyCopy(faceUser1, 0.005, 3),
          ],
          lat: OFFICE_LAT,
          lng: OFFICE_LNG,
          accuracy: 15,
        },
      });
      record('Valid check-in inside radius succeeds (200, status PRESENT/LATE)', res.status === 200 && res.body?.success === true);
    }

    // Test 16: Challenge reuse attempt -> 400
    {
      const res = await api('/api/attendance/check-in', {
        method: 'POST',
        token: tokenEmployee1,
        body: {
          challengeId: checkinChallengeId,
          descriptors: [
            noisyCopy(faceUser1, 0.005, 1),
            noisyCopy(faceUser1, 0.005, 2),
            noisyCopy(faceUser1, 0.005, 3),
          ],
          lat: OFFICE_LAT,
          lng: OFFICE_LNG,
          accuracy: 15,
        },
      });
      record('Reused challenge rejected with 400', res.status === 400);
    }

    // Test 17: Duplicate check-in on same day -> 409
    {
      const chalRes = await api('/api/attendance/challenge', {
        method: 'POST',
        token: tokenEmployee1,
        body: { purpose: 'checkin', lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 15 },
      });
      const chalId = chalRes.body?.data?.challengeId;
      await pool.query(
        `UPDATE attendance_challenges SET issued_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 SECOND) WHERE id = ?`,
        [chalId]
      );

      const res = await api('/api/attendance/check-in', {
        method: 'POST',
        token: tokenEmployee1,
        body: {
          challengeId: chalId,
          descriptors: [
            noisyCopy(faceUser1, 0.005, 1),
            noisyCopy(faceUser1, 0.005, 2),
            noisyCopy(faceUser1, 0.005, 3),
          ],
          lat: OFFICE_LAT,
          lng: OFFICE_LNG,
          accuracy: 15,
        },
      });
      record('Second check-in on the same day returns 409 Conflict', res.status === 409);
    }

    // Test 18: Heartbeat GPS Jitter & Three-Way Classification Rules
    {
      // 18a. Accuracy 120 with d 30 and R 150 (d + a <= R) -> stays INSIDE
      const resInsideProven = await api('/api/attendance/heartbeat', {
        method: 'POST',
        token: tokenEmployee1,
        body: { lat: OFFICE_LAT + 0.00027, lng: OFFICE_LNG, accuracy: 120 },
      });
      record('accuracy 120 with d 30 and R 150 stays INSIDE', resInsideProven.body?.data?.state === 'INSIDE');

      // 18b. Accuracy 5000 (weak reading) never refreshes last_inside_at and reaches UNKNOWN after 3 readings
      const [beforeRows] = await pool.query('SELECT last_inside_at FROM attendance_presence WHERE user_id = ?', [FIXTURE_USER_1]);
      const initialLastInsideAt = beforeRows[0]?.last_inside_at;

      await api('/api/attendance/heartbeat', {
        method: 'POST',
        token: tokenEmployee1,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 5000 },
      });
      await api('/api/attendance/heartbeat', {
        method: 'POST',
        token: tokenEmployee1,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 5000 },
      });
      const resWeak3 = await api('/api/attendance/heartbeat', {
        method: 'POST',
        token: tokenEmployee1,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 5000 },
      });

      const [afterRows] = await pool.query('SELECT last_inside_at FROM attendance_presence WHERE user_id = ?', [FIXTURE_USER_1]);
      const afterLastInsideAt = afterRows[0]?.last_inside_at;

      const unrefreshed = String(initialLastInsideAt) === String(afterLastInsideAt);
      const reachesUnknown = resWeak3.body?.data?.state === 'UNKNOWN' && resWeak3.body?.data?.reason === 'weak_gps';
      record('accuracy 5000 never refreshes last_inside_at and reaches UNKNOWN after 3 readings', unrefreshed && reachesUnknown);

      // Re-verify to restore INSIDE before testing OUTSIDE classification
      const chal1 = await api('/api/attendance/challenge', {
        method: 'POST',
        token: tokenEmployee1,
        body: { purpose: 'reverify', lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 15 },
      });
      await pool.query('UPDATE attendance_challenges SET issued_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 SECOND) WHERE id = ?', [chal1.body?.data?.challengeId]);
      await api('/api/attendance/reverify', {
        method: 'POST',
        token: tokenEmployee1,
        body: {
          challengeId: chal1.body?.data?.challengeId,
          descriptors: [noisyCopy(faceUser1, 0.005, 1), noisyCopy(faceUser1, 0.005, 2), noisyCopy(faceUser1, 0.005, 3)],
          lat: OFFICE_LAT,
          lng: OFFICE_LNG,
          accuracy: 15,
        },
      });

      // 18c. Accuracy 100 with d 900 (d - a > R) -> becomes OUTSIDE (reason "left")
      const resOutside900 = await api('/api/attendance/heartbeat', {
        method: 'POST',
        token: tokenEmployee1,
        body: { lat: OFFICE_LAT + 0.0081, lng: OFFICE_LNG, accuracy: 100 },
      });
      record('accuracy 100 with d 900 becomes OUTSIDE (reason "left")', resOutside900.body?.data?.state === 'OUTSIDE' && resOutside900.body?.data?.reason === 'left');

      // 18d. Weak readings x3 while OUTSIDE stay OUTSIDE
      await api('/api/attendance/heartbeat', {
        method: 'POST',
        token: tokenEmployee1,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 5000 },
      });
      await api('/api/attendance/heartbeat', {
        method: 'POST',
        token: tokenEmployee1,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 5000 },
      });
      const resWeak3Outside = await api('/api/attendance/heartbeat', {
        method: 'POST',
        token: tokenEmployee1,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 5000 },
      });
      record('weak readings x3 while OUTSIDE stay OUTSIDE', resWeak3Outside.body?.data?.state === 'OUTSIDE' && resWeak3Outside.body?.data?.reason === 'left');

      // 18e. Return rule: Returning physically inside does NOT reset state to INSIDE via heartbeat alone
      const resReturn = await api('/api/attendance/heartbeat', {
        method: 'POST',
        token: tokenEmployee1,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 10 },
      });
      const returnStateOutside = resReturn.body?.data?.state === 'OUTSIDE';
      const returnReverifyReq = resReturn.body?.data?.reverifyRequired === true;
      record('Return flow: heartbeat alone keeps presence OUTSIDE until reverify', returnStateOutside);

      // Verify me/status also shows reverifyRequired true
      const statusWhileOutsideReturn = await api('/api/attendance/me/status', {
        method: 'GET',
        token: tokenEmployee1,
      });
      const statusReverifyReq = statusWhileOutsideReturn.body?.data?.reverifyRequired === true;
      record('left then returned shows reverifyRequired true on the first inside heartbeat', returnReverifyReq && statusReverifyReq);
    }

    // Test 19: Re-verify restores INSIDE state
    {
      const chalRes = await api('/api/attendance/challenge', {
        method: 'POST',
        token: tokenEmployee1,
        body: { purpose: 'reverify', lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 15 },
      });
      const reverifyChalId = chalRes.body?.data?.challengeId;
      await pool.query(
        `UPDATE attendance_challenges SET issued_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 SECOND) WHERE id = ?`,
        [reverifyChalId]
      );

      const res = await api('/api/attendance/reverify', {
        method: 'POST',
        token: tokenEmployee1,
        body: {
          challengeId: reverifyChalId,
          descriptors: [
            noisyCopy(faceUser1, 0.005, 1),
            noisyCopy(faceUser1, 0.005, 2),
            noisyCopy(faceUser1, 0.005, 3),
          ],
          lat: OFFICE_LAT,
          lng: OFFICE_LNG,
          accuracy: 15,
        },
      });
      record('Re-verification inside office restores presence to INSIDE', res.status === 200 && res.body?.data?.state === 'INSIDE');

      // Check me/status: reverifyRequired must now be false
      const statusAfterReverify = await api('/api/attendance/me/status', {
        method: 'GET',
        token: tokenEmployee1,
      });
      const reverifyFalse = statusAfterReverify.body?.data?.reverifyRequired === false && statusAfterReverify.body?.data?.presenceState === 'INSIDE';
      record('reverifyRequired false after /reverify', reverifyFalse);

      // 19b. UNKNOWN with left_alerted_at set plus an inside reading shows reverifyRequired true
      await pool.query(
        "UPDATE attendance_presence SET state = 'UNKNOWN', reason = 'no_signal', left_alerted_at = UTC_TIMESTAMP() WHERE user_id = ?",
        [FIXTURE_USER_1]
      );
      const resUnknownInside = await api('/api/attendance/heartbeat', {
        method: 'POST',
        token: tokenEmployee1,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 10 },
      });
      const statusUnknown = await api('/api/attendance/me/status', {
        method: 'GET',
        token: tokenEmployee1,
      });
      const unknownAlertedReverify =
        resUnknownInside.body?.data?.state === 'UNKNOWN' &&
        resUnknownInside.body?.data?.reverifyRequired === true &&
        statusUnknown.body?.data?.presenceState === 'UNKNOWN' &&
        statusUnknown.body?.data?.reverifyRequired === true;
      record('UNKNOWN with left_alerted_at set plus an inside reading shows reverifyRequired true', unknownAlertedReverify);

      // Restore to INSIDE before concurrency test
      await pool.query(
        "UPDATE attendance_presence SET state = 'INSIDE', reason = NULL, left_alerted_at = NULL WHERE user_id = ?",
        [FIXTURE_USER_1]
      );

      // 19c. Concurrent state change returns the current state
      const origUpdate = AttendancePresenceModel.updateConditional;
      AttendancePresenceModel.updateConditional = async function (...args) {
        // Concurrently change state in DB to 'OUTSIDE' so expectedState: 'INSIDE' condition fails (0 rows affected)
        await pool.query("UPDATE attendance_presence SET state = 'OUTSIDE', reason = 'left' WHERE user_id = ?", [FIXTURE_USER_1]);
        return origUpdate.apply(this, args);
      };
      try {
        const resConcurrent = await api('/api/attendance/heartbeat', {
          method: 'POST',
          token: tokenEmployee1,
          body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 10 },
        });
        const concurrentHandled = resConcurrent.status === 200 && resConcurrent.body?.data?.state === 'OUTSIDE';
        record('concurrent state change returns the current state', concurrentHandled);
      } finally {
        AttendancePresenceModel.updateConditional = origUpdate;
      }
    }

    // Test 20: Check-out from any location (allowed outside radius)
    {
      const res = await api('/api/attendance/check-out', {
        method: 'POST',
        token: tokenEmployee1,
        body: { lat: OFFICE_LAT + 0.05, lng: OFFICE_LNG + 0.05, accuracy: 25 },
      });
      record('Check-out from outside location succeeds (200, worked_minutes computed)', res.status === 200 && res.body?.data?.workedMinutes !== undefined);
    }

    // Test 21: Heartbeat after check-out returns 409
    {
      const res = await api('/api/attendance/heartbeat', {
        method: 'POST',
        token: tokenEmployee1,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 15 },
      });
      record('Heartbeat after check-out returns 409', res.status === 409);
    }

    // Test 22: Rate limiting lock after 5 failures -> 429
    {
      // Log 5 failed attempts for User 3 to trigger rate limiting lockout
      for (let i = 0; i < 5; i++) {
        await recordAttempt({
          userId: FIXTURE_USER_OTHER,
          kind: 'checkin',
          success: false,
          accuracy: 15,
          ip: '127.0.0.1',
          reason: 'test_failure',
        });
      }

      // 6th attempt should trigger 429 lock
      const user3Token = makeEmployeeToken(FIXTURE_USER_OTHER);
      const res = await api('/api/attendance/challenge', {
        method: 'POST',
        token: user3Token,
        body: { purpose: 'checkin', lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 15 },
      });
      record('5 recent failures trigger 429 rate limit lockout', res.status === 429);
    }

  } catch (err) {
    console.error('💥 Test suite crashed with error:', err);
    record('Test suite execution completed without fatal errors', false, err.message);
  } finally {
    // ── Teardown Fixtures ───────────────────────────────────────────────────
    console.log('\n🧹 Cleaning up test fixtures...');
    try {
      const fixtureUsers = [FIXTURE_USER_1, FIXTURE_USER_2, FIXTURE_USER_OTHER];

      // Get record ids for fixture users
      const [recordRows] = await pool.query(
        `SELECT id FROM attendance_records WHERE user_id IN (?, ?, ?)`,
        fixtureUsers
      );
      const recordIds = recordRows.map((r) => r.id);

      if (recordIds.length > 0) {
        const placeholders = recordIds.map(() => '?').join(',');
        await pool.query(`DELETE FROM attendance_intervals WHERE record_id IN (${placeholders})`, recordIds);
        await pool.query(`DELETE FROM attendance_presence WHERE record_id IN (${placeholders})`, recordIds);
        await pool.query(`DELETE FROM attendance_reverify_tasks WHERE record_id IN (${placeholders})`, recordIds);
      }

      await pool.query(`DELETE FROM attendance_records WHERE user_id IN (?, ?, ?)`, fixtureUsers);
      await pool.query(`DELETE FROM attendance_attempts WHERE user_id IN (?, ?, ?)`, fixtureUsers);
      await pool.query(`DELETE FROM attendance_challenges WHERE user_id IN (?, ?, ?)`, fixtureUsers);
      await pool.query(`DELETE FROM attendance_profiles WHERE user_id IN (?, ?, ?)`, fixtureUsers);
      await pool.query(`DELETE FROM attendance_regularizations WHERE user_id IN (?, ?, ?)`, fixtureUsers);

      if (FIXTURE_ADMIN_ID) {
        await pool.query(`DELETE FROM attendance_audit_log WHERE actor_admin_id = ? OR entity_id IN (?, ?, ?)`, [
          FIXTURE_ADMIN_ID,
          ...fixtureUsers,
        ]);
        await pool.query(`DELETE FROM admins WHERE id = ?`, [FIXTURE_ADMIN_ID]);
      }

      await pool.query(`DELETE FROM site_users WHERE user_id IN (?, ?, ?)`, fixtureUsers);

      if (FIXTURE_OFFICE_ID) {
        await pool.query(`DELETE FROM attendance_offices WHERE id = ?`, [FIXTURE_OFFICE_ID]);
      }

      console.log('✅ Fixtures cleaned up cleanly.');
    } catch (cleanupErr) {
      console.warn('⚠️  Cleanup warning:', cleanupErr.message);
    }

    if (server) {
      server.close();
    }
  }

  // Summary
  const passedCount = results.filter((r) => r.passed).length;
  const totalCount = results.length;
  console.log(`\n========================================`);
  console.log(`Test Results: ${passedCount}/${totalCount} passed`);
  console.log(`========================================\n`);

  if (passedCount < totalCount) {
    process.exit(1);
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
  });
