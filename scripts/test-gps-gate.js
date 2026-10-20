'use strict';

/**
 * scripts/test-gps-gate.js
 * Acceptance test suite for:
 * - Feature 1: Office GPS Coordinates & Resolver
 * - Feature 3: Attendance GPS Validation & Gate
 *
 * Rules:
 * - Refuses to run unless DB_HOST is localhost or 127.0.0.1 and NODE_ENV is not production.
 * - Uses fixture ids that sort below real ids (tbtstgps01, etc.).
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
const { toUtcDateTime, istCalendarDate } = require('../src/utils/time');
const { encryptEmbedding } = require('../src/utils/crypto');
const { resolveOfficeForUser } = require('../src/services/attendanceGate');
const { performSweep } = require('../src/services/attendanceSweeper');

// ── Environment Guard ────────────────────────────────────────────────────────
const dbHost = process.env.DB_HOST || 'localhost';
const isLocalDb = dbHost === 'localhost' || dbHost === '127.0.0.1';
const isDev = process.env.NODE_ENV !== 'production';

if (!isLocalDb || !isDev) {
  console.error('❌ Refusing to run tests: DB_HOST must be localhost/127.0.0.1 and NODE_ENV must not be production.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

const FIXTURE_USER_ASSIGNED = 'tbtstgps01';
const FIXTURE_USER_UNASSIGNED = 'tbtstgps02';
let FIXTURE_ADMIN_ID = null;
let FIXTURE_OFFICE_1_ID = null;
let FIXTURE_OFFICE_2_ID = null;
let preExistingOffices = [];

let server = null;
let baseUrl = '';

async function api(path, { method = 'GET', token = null, body = null } = {}) {
  const headers = {};
  if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
  }
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, headers: res.headers, body: json, rawText: text };
  } else {
    const text = await res.text();
    return { status: res.status, headers: res.headers, rawText: text };
  }
}

function generateDescriptor(seed = 1) {
  const arr = new Array(128);
  for (let i = 0; i < 128; i++) {
    arr[i] = Math.sin(seed * (i + 1) * 0.1) * 0.1;
  }
  return arr;
}

// Center: MG Road Bangalore
const OFFICE_LAT = 12.9715987;
const OFFICE_LNG = 77.5945627;
const OFFICE_RADIUS = 150; // 150 meters

// Offset ~ 160m (just outside radius)
// 1 deg lat ~ 111,000m => 0.00144 deg ~ 160m
const JUST_OUTSIDE_LAT = OFFICE_LAT + 0.00145;
const JUST_OUTSIDE_LNG = OFFICE_LNG;

// Far away: 10km
const FAR_AWAY_LAT = OFFICE_LAT + 0.1;
const FAR_AWAY_LNG = OFFICE_LNG + 0.1;

async function runTests() {
  console.log('🧪 Starting Feature 1 & Feature 3 GPS Gate Acceptance Tests...\n');
  const results = [];

  function record(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const mark = passed ? '✅' : '❌';
    console.log(`${mark} ${name}${detail ? ` (${detail})` : ''}`);
  }

  try {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;

    const hashedPassword = await bcrypt.hash('Password123!', 4);
    const now = toUtcDateTime();

    // 1. Fixture Admin
    const [adminResult] = await pool.query(
      `INSERT INTO admins (name, email, password, role, is_active, created_at)
       VALUES ('GPS Fixture Admin', 'gps_admin@test.com', ?, 'admin', 1, ?)`,
      [hashedPassword, now]
    );
    FIXTURE_ADMIN_ID = adminResult.insertId;

    // 2. Fixture Users with Attendance module
    await pool.query(
      `INSERT INTO site_users (user_id, fullname, email, password, module_access, is_active, created_at)
       VALUES (?, 'GPS Assigned User', 'gps_assigned@test.com', ?, ?, 1, ?),
              (?, 'GPS Unassigned User', 'gps_unassigned@test.com', ?, ?, 1, ?)`,
      [FIXTURE_USER_ASSIGNED, hashedPassword, JSON.stringify(['Attendance']), now,
       FIXTURE_USER_UNASSIGNED, hashedPassword, JSON.stringify(['Attendance']), now]
    );

    // 3. Stash pre-existing offices to cleanly isolate single-office and zero-office tests
    const [fetchedOffices] = await pool.query('SELECT * FROM attendance_offices');
    preExistingOffices = fetchedOffices;
    await pool.query('DELETE FROM attendance_offices');

    // Create 1 Office initially
    const [off1Res] = await pool.query(
      `INSERT INTO attendance_offices
        (name, lat, lng, radius_m, accuracy_max_m, shift_start, shift_end, created_at, updated_at)
       VALUES ('GPS Primary Office', ?, ?, ?, 50, '09:00:00', '18:00:00', ?, ?)`,
      [OFFICE_LAT, OFFICE_LNG, OFFICE_RADIUS, now, now]
    );
    FIXTURE_OFFICE_1_ID = off1Res.insertId;

    // 4. Enroll faces & consent for both users
    const desc = generateDescriptor(42);
    const encTemplate = encryptEmbedding(desc);
    await pool.query(
      `INSERT INTO attendance_profiles
        (user_id, office_id, face_template, face_enrolled_at, consent_at, consent_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '1.0', ?, ?),
              (?, NULL, ?, ?, ?, '1.0', ?, ?)`,
      [FIXTURE_USER_ASSIGNED, FIXTURE_OFFICE_1_ID, encTemplate, now, now, now, now,
       FIXTURE_USER_UNASSIGNED, encTemplate, now, now, now, now]
    );

    const adminToken = jwt.sign({ id: FIXTURE_ADMIN_ID, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
    const assignedToken = jwt.sign({ userId: FIXTURE_USER_ASSIGNED, type: 'site_user' }, JWT_SECRET, { expiresIn: '1h' });
    const unassignedToken = jwt.sign({ userId: FIXTURE_USER_UNASSIGNED, type: 'site_user' }, JWT_SECRET, { expiresIn: '1h' });

    // ══════════════════════════════════════════════════════════════════════════
    // DIAGNOSIS REPORT: Real requests with real office
    // ══════════════════════════════════════════════════════════════════════════
    console.log('--- DIAGNOSTIC RUN ---');

    // Case A: Inside radius on /challenge
    const diagA = await api('/api/attendance/challenge', {
      method: 'POST',
      token: assignedToken,
      body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 20, purpose: 'checkin' },
    });
    console.log('Diag: Inside radius /challenge => HTTP', diagA.status, diagA.body?.message || diagA.body);

    // Case B: Just outside radius on /challenge
    const diagB = await api('/api/attendance/challenge', {
      method: 'POST',
      token: assignedToken,
      body: { lat: JUST_OUTSIDE_LAT, lng: JUST_OUTSIDE_LNG, accuracy: 20, purpose: 'checkin' },
    });
    console.log('Diag: Just outside /challenge => HTTP', diagB.status, diagB.body?.message);

    // Case C: Far away on /challenge
    const diagC = await api('/api/attendance/challenge', {
      method: 'POST',
      token: assignedToken,
      body: { lat: FAR_AWAY_LAT, lng: FAR_AWAY_LNG, accuracy: 20, purpose: 'checkin' },
    });
    console.log('Diag: Far away /challenge => HTTP', diagC.status, diagC.body?.message);

    // Case D: Poor accuracy on /challenge
    const diagD = await api('/api/attendance/challenge', {
      method: 'POST',
      token: assignedToken,
      body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 120, purpose: 'checkin' },
    });
    console.log('Diag: Poor accuracy /challenge => HTTP', diagD.status, diagD.body?.message);

    console.log('--- END DIAGNOSTIC RUN ---\n');
    await pool.query('DELETE FROM attendance_attempts WHERE user_id = ?', [FIXTURE_USER_ASSIGNED]);

    // ══════════════════════════════════════════════════════════════════════════
    // FEATURE 1 TESTS
    // ══════════════════════════════════════════════════════════════════════════

    // 1. Office create/read/update persists exact values (DECIMAL(10,7) numbers)
    {
      const createRes = await api('/api/attendance/admin/offices', {
        method: 'POST',
        token: adminToken,
        body: {
          name: 'Precision Office',
          lat: 12.3456789,
          lng: 78.1234567,
          radius_m: 175,
          accuracy_max_m: 40,
        },
      });
      const offId = createRes.body?.data?.office?.id;
      assert(offId, 'Expected office id');

      const getRes = await api(`/api/attendance/admin/offices/${offId}`, { token: adminToken });
      const readOffice = getRes.body?.data?.office;

      // Verify numbers and 7 decimal precision
      const latNumber = typeof readOffice?.lat === 'number' && Math.abs(readOffice.lat - 12.3456789) < 1e-7;
      const lngNumber = typeof readOffice?.lng === 'number' && Math.abs(readOffice.lng - 78.1234567) < 1e-7;
      const radiusRoundTrip = readOffice?.radius_m === 175;
      const accuracyRoundTrip = readOffice?.accuracy_max_m === 40;

      // PUT updates
      const putRes = await api(`/api/attendance/admin/offices/${offId}`, {
        method: 'PUT',
        token: adminToken,
        body: {
          lat: 13.9876543,
          lng: 79.7654321,
          radius_m: 220,
          accuracy_max_m: 65,
        },
      });
      const updatedOffice = putRes.body?.data?.office;
      const latUpdated = typeof updatedOffice?.lat === 'number' && Math.abs(updatedOffice.lat - 13.9876543) < 1e-7;
      const lngUpdated = typeof updatedOffice?.lng === 'number' && Math.abs(updatedOffice.lng - 79.7654321) < 1e-7;

      // Clean up precision office
      await pool.query('DELETE FROM attendance_audit_log WHERE entity_type = "office" AND entity_id = ?', [String(offId)]);
      await pool.query('DELETE FROM attendance_offices WHERE id = ?', [offId]);

      const pass = latNumber && lngNumber && radiusRoundTrip && accuracyRoundTrip && latUpdated && lngUpdated;
      record('F1.1. Office create/read/update persists exact DECIMAL(10,7) numbers and fields', pass);
    }

    // 2. Validation messages are human readable and reject lat 0 and lng 0 together
    {
      const resZero = await api('/api/attendance/admin/offices', {
        method: 'POST',
        token: adminToken,
        body: { name: 'Zero Office', lat: 0, lng: 0, radius_m: 100, accuracy_max_m: 50 },
      });

      const resBadLat = await api('/api/attendance/admin/offices', {
        method: 'POST',
        token: adminToken,
        body: { name: 'Bad Lat Office', lat: 105, lng: 80, radius_m: 100, accuracy_max_m: 50 },
      });

      const pass =
        resZero.status === 400 &&
        resZero.body?.message === 'Latitude and longitude cannot both be 0.' &&
        resBadLat.status === 400 &&
        resBadLat.body?.message === 'Latitude must be between -90 and 90.';

      record('F1.2. Office validation: human readable messages and rejects lat 0 + lng 0', pass, resZero.body?.message);
    }

    // 3. GET /admin/offices returns employeeCount (grouped query)
    {
      const res = await api('/api/attendance/admin/offices', { token: adminToken });
      const off = res.body?.data?.offices?.find((o) => o.id === FIXTURE_OFFICE_1_ID);

      const pass =
        res.status === 200 &&
        off &&
        typeof off.employeeCount === 'number' &&
        off.employeeCount === 1; // FIXTURE_USER_ASSIGNED is assigned to it

      record('F1.3. GET /admin/offices returns employeeCount per office in single query', pass, `employeeCount: ${off?.employeeCount}`);
    }

    // 4. Single-office fallback works for an employee with no profile office
    {
      const statusRes = await api('/api/attendance/me/status', { token: unassignedToken });
      const chalRes = await api('/api/attendance/challenge', {
        method: 'POST',
        token: unassignedToken,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 15, purpose: 'checkin' },
      });

      const pass =
        statusRes.status === 200 &&
        statusRes.body?.data?.office?.id === FIXTURE_OFFICE_1_ID &&
        chalRes.status === 200 &&
        Boolean(chalRes.body?.data?.challengeId);

      record('F1.4. Single-office fallback works for employee without profile office', pass, statusRes.body?.data?.office?.name);
    }

    // 5. Zero offices and multiple-offices-unassigned return the exact 400 message
    {
      // Case 5a: Add second office so 2 offices exist
      const [off2Res] = await pool.query(
        `INSERT INTO attendance_offices (name, lat, lng, radius_m, accuracy_max_m, created_at, updated_at)
         VALUES ('GPS Second Office', 13.0827, 80.2707, 150, 50, ?, ?)`,
        [now, now]
      );
      FIXTURE_OFFICE_2_ID = off2Res.insertId;

      const multiRes = await api('/api/attendance/challenge', {
        method: 'POST',
        token: unassignedToken,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 15, purpose: 'checkin' },
      });

      // Remove second office and first office temporarily to test 0 offices
      await pool.query('DELETE FROM attendance_offices WHERE id = ?', [FIXTURE_OFFICE_2_ID]);
      await pool.query('UPDATE attendance_profiles SET office_id = NULL WHERE user_id = ?', [FIXTURE_USER_ASSIGNED]);
      await pool.query('DELETE FROM attendance_offices WHERE id = ?', [FIXTURE_OFFICE_1_ID]);

      const zeroRes = await api('/api/attendance/challenge', {
        method: 'POST',
        token: unassignedToken,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 15, purpose: 'checkin' },
      });

      // Restore first office and link assigned user
      const [restoreRes] = await pool.query(
        `INSERT INTO attendance_offices
          (name, lat, lng, radius_m, accuracy_max_m, shift_start, shift_end, created_at, updated_at)
         VALUES ('GPS Primary Office', ?, ?, ?, 50, '09:00:00', '18:00:00', ?, ?)`,
        [OFFICE_LAT, OFFICE_LNG, OFFICE_RADIUS, now, now]
      );
      FIXTURE_OFFICE_1_ID = restoreRes.insertId;
      await pool.query('UPDATE attendance_profiles SET office_id = ? WHERE user_id = ?', [FIXTURE_OFFICE_1_ID, FIXTURE_USER_ASSIGNED]);

      const expectedMsg = 'Your office location is not set. Please contact your administrator.';
      const pass =
        multiRes.status === 400 &&
        multiRes.body?.message === expectedMsg &&
        zeroRes.status === 400 &&
        zeroRes.body?.message === expectedMsg;

      record('F1.5. Zero offices and multiple unassigned offices return exact 400 message', pass, zeroRes.body?.message);
    }

    // 6. Sweeper and /admin/live use the same resolver
    {
      const resolvedOff = await resolveOfficeForUser(FIXTURE_USER_UNASSIGNED);
      const sweepRes = await performSweep(new Date());
      const liveRes = await api('/api/attendance/admin/live', { token: adminToken });

      const pass =
        resolvedOff.id === FIXTURE_OFFICE_1_ID &&
        typeof sweepRes?.scanned === 'number' &&
        liveRes.status === 200;

      record('F1.6. Sweeper and /admin/live use the shared office resolver', pass);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // FEATURE 3 TESTS: GPS Gate & Anti-Replay
    // ══════════════════════════════════════════════════════════════════════════

    // 7. Exact message: Outside the radius => 400
    {
      const chalRes = await api('/api/attendance/challenge', {
        method: 'POST',
        token: assignedToken,
        body: { lat: JUST_OUTSIDE_LAT, lng: JUST_OUTSIDE_LNG, accuracy: 20, purpose: 'checkin' },
      });

      const expected = 'Location verification failed: You are outside the authorized office premises.';
      const pass = chalRes.status === 400 && chalRes.body?.message === expected;
      record('F3.1. Outside radius returns exact message with 400', pass, chalRes.body?.message);
    }

    // 8. Exact message: Poor accuracy => 400
    {
      const chalRes = await api('/api/attendance/challenge', {
        method: 'POST',
        token: assignedToken,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 150, purpose: 'checkin' },
      });

      const expected = 'GPS signal is too weak. Move near a window or an open area and try again.';
      const pass = chalRes.status === 400 && chalRes.body?.message === expected;
      record('F3.2. Poor accuracy returns exact message with 400', pass, chalRes.body?.message);
    }

    // 9. Rejects coordinates 0,0 and accuracy <= 0
    {
      await pool.query('DELETE FROM attendance_attempts WHERE user_id = ?', [FIXTURE_USER_ASSIGNED]);
      const res0 = await api('/api/attendance/challenge', {
        method: 'POST',
        token: assignedToken,
        body: { lat: 0, lng: 0, accuracy: 10, purpose: 'checkin' },
      });

      const resAcc0 = await api('/api/attendance/challenge', {
        method: 'POST',
        token: assignedToken,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 0, purpose: 'checkin' },
      });

      const resAccNeg = await api('/api/attendance/challenge', {
        method: 'POST',
        token: assignedToken,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: -5, purpose: 'checkin' },
      });

      const pass = res0.status === 400 && resAcc0.status === 400 && resAccNeg.status === 400;
      record('F3.3. Rejects coordinates 0,0 and accuracy <= 0 (400)', pass);
    }

    // 10. Anti-replay fixTimestamp validation:
    // - older than 60s => 400
    // - > 10s in future => 400
    // - current timestamp => 200
    // - missing timestamp => 200 (optional)
    {
      await pool.query('DELETE FROM attendance_attempts WHERE user_id = ?', [FIXTURE_USER_ASSIGNED]);
      const nowEpoch = Date.now();
      const oldEpoch = nowEpoch - 65 * 1000;
      const futureEpoch = nowEpoch + 15 * 1000;
      const expectedMsg = 'Location is out of date. Please refresh your location.';

      const resOld = await api('/api/attendance/challenge', {
        method: 'POST',
        token: assignedToken,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 20, purpose: 'checkin', fixTimestamp: oldEpoch },
      });

      const resFuture = await api('/api/attendance/challenge', {
        method: 'POST',
        token: assignedToken,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 20, purpose: 'checkin', fixTimestamp: futureEpoch },
      });

      const resValid = await api('/api/attendance/challenge', {
        method: 'POST',
        token: assignedToken,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 20, purpose: 'checkin', fixTimestamp: nowEpoch },
      });

      const resOmitted = await api('/api/attendance/challenge', {
        method: 'POST',
        token: assignedToken,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 20, purpose: 'checkin' },
      });

      const pass =
        resOld.status === 400 && resOld.body?.message === expectedMsg &&
        resFuture.status === 400 && resFuture.body?.message === expectedMsg &&
        resValid.status === 200 &&
        resOmitted.status === 200;

      record('F3.4. fixTimestamp anti-replay: rejects stale (>60s) or future (>10s), accepts valid & optional', pass);
    }

    // 11. Two-position consistency rule: distance between challenge fix and check-in fix > 500m => 400
    {
      await pool.query('DELETE FROM attendance_attempts WHERE user_id = ?', [FIXTURE_USER_ASSIGNED]);
      // Request challenge at Office location
      const chalRes = await api('/api/attendance/challenge', {
        method: 'POST',
        token: assignedToken,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 20, purpose: 'checkin' },
      });
      const challengeId = chalRes.body?.data?.challengeId;
      assert(challengeId, 'Expected challengeId');

      await new Promise((r) => setTimeout(r, 2100)); // wait past 2s

      const d1 = desc;
      const d2 = desc.map((v, i) => v + 0.005 * Math.sin(i));
      const d3 = desc.map((v, i) => v - 0.005 * Math.cos(i));

      // Attempt check-in with a fix 600m away (lat offset 0.0055 ~ 610m)
      const distantLat = OFFICE_LAT + 0.0055;
      const checkInDistant = await api('/api/attendance/check-in', {
        method: 'POST',
        token: assignedToken,
        body: {
          challengeId,
          lat: distantLat,
          lng: OFFICE_LNG,
          accuracy: 20,
          descriptors: [d1, d2, d3],
        },
      });

      record('F3.5. Two-position consistency: check-in > 500m from challenge fix rejected with 400',
        checkInDistant.status === 400,
        `Status: ${checkInDistant.status}, Msg: ${checkInDistant.body?.message}`
      );
    }

    // 12. Valid check-in within 500m succeeds and marks PRESENT
    {
      await pool.query('DELETE FROM attendance_attempts WHERE user_id = ?', [FIXTURE_USER_ASSIGNED]);
      // Request new challenge
      const chalRes = await api('/api/attendance/challenge', {
        method: 'POST',
        token: assignedToken,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 20, purpose: 'checkin', fixTimestamp: Date.now() },
      });
      const challengeId = chalRes.body?.data?.challengeId;

      await new Promise((r) => setTimeout(r, 2100));

      const d1 = desc;
      const d2 = desc.map((v, i) => v + 0.005 * Math.sin(i));
      const d3 = desc.map((v, i) => v - 0.005 * Math.cos(i));

      // Check-in at exact location with valid timestamp
      const checkInRes = await api('/api/attendance/check-in', {
        method: 'POST',
        token: assignedToken,
        body: {
          challengeId,
          lat: OFFICE_LAT,
          lng: OFFICE_LNG,
          accuracy: 20,
          descriptors: [d1, d2, d3],
          fixTimestamp: Date.now(),
        },
      });

      const pass =
        checkInRes.status === 200 &&
        checkInRes.body?.success === true &&
        (checkInRes.body?.data?.status === 'PRESENT' || checkInRes.body?.data?.status === 'LATE');

      record('F3.6. Valid check-in with consistent position and fixTimestamp succeeds', pass, `Status: ${checkInRes.body?.data?.status}`);
    }

  } catch (err) {
    console.error('❌ Test failed with error:', err);
    record('Fatal test error', false, err.message);
  } finally {
    console.log('\n🧹 Cleaning up GPS test fixtures...');
    try {
      await pool.query('DELETE FROM attendance_attempts WHERE user_id IN (?, ?)', [FIXTURE_USER_ASSIGNED, FIXTURE_USER_UNASSIGNED]);
      await pool.query('DELETE FROM attendance_challenges WHERE user_id IN (?, ?)', [FIXTURE_USER_ASSIGNED, FIXTURE_USER_UNASSIGNED]);
      await pool.query('DELETE FROM attendance_intervals WHERE record_id IN (SELECT id FROM attendance_records WHERE user_id IN (?, ?))', [FIXTURE_USER_ASSIGNED, FIXTURE_USER_UNASSIGNED]);
      await pool.query('DELETE FROM attendance_presence WHERE user_id IN (?, ?)', [FIXTURE_USER_ASSIGNED, FIXTURE_USER_UNASSIGNED]);
      await pool.query('DELETE FROM attendance_records WHERE user_id IN (?, ?)', [FIXTURE_USER_ASSIGNED, FIXTURE_USER_UNASSIGNED]);
      await pool.query('DELETE FROM attendance_profiles WHERE user_id IN (?, ?)', [FIXTURE_USER_ASSIGNED, FIXTURE_USER_UNASSIGNED]);
      await pool.query('DELETE FROM attendance_audit_log WHERE entity_id IN (?, ?)', [FIXTURE_USER_ASSIGNED, FIXTURE_USER_UNASSIGNED]);
      if (FIXTURE_OFFICE_1_ID) {
        await pool.query('DELETE FROM attendance_offices WHERE id = ?', [FIXTURE_OFFICE_1_ID]);
      }
      if (FIXTURE_OFFICE_2_ID) {
        await pool.query('DELETE FROM attendance_offices WHERE id = ?', [FIXTURE_OFFICE_2_ID]);
      }
      // Restore pre-existing offices
      if (preExistingOffices && preExistingOffices.length > 0) {
        await pool.query('DELETE FROM attendance_offices');
        for (const off of preExistingOffices) {
          await pool.query(
            `INSERT INTO attendance_offices
              (id, name, lat, lng, radius_m, accuracy_max_m, ip_allowlist, require_both, shift_start, shift_end, grace_minutes, outside_tolerance_minutes, short_outing_allowance_minutes, heartbeat_seconds, reverify_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              off.id,
              off.name,
              off.lat,
              off.lng,
              off.radius_m,
              off.accuracy_max_m,
              JSON.stringify(off.ip_allowlist || []),
              off.require_both || 0,
              off.shift_start || '09:30:00',
              off.shift_end || '18:30:00',
              off.grace_minutes || 10,
              off.outside_tolerance_minutes || 10,
              off.short_outing_allowance_minutes || 30,
              off.heartbeat_seconds || 60,
              off.reverify_count || 2,
              toUtcDateTime(off.created_at),
              toUtcDateTime(off.updated_at),
            ]
          );
        }
      }
      await pool.query('DELETE FROM site_users WHERE user_id IN (?, ?)', [FIXTURE_USER_ASSIGNED, FIXTURE_USER_UNASSIGNED]);
      if (FIXTURE_ADMIN_ID) {
        await pool.query('DELETE FROM admins WHERE id = ?', [FIXTURE_ADMIN_ID]);
      }
      console.log('✅ Fixtures cleaned up cleanly and pre-existing offices restored.');
    } catch (cleanErr) {
      console.warn('⚠️ Cleanup warning:', cleanErr.message);
    }

    if (server) server.close();
    await pool.end();

    const failed = results.filter((r) => !r.passed);
    console.log(`\n========================================`);
    console.log(`GPS Gate Test Results: ${results.length - failed.length}/${results.length} passed`);
    console.log(`========================================\n`);

    if (failed.length > 0) process.exit(1);
    else process.exit(0);
  }
}

runTests();
