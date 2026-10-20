'use strict';

/**
 * scripts/test-photo.js
 * Acceptance test suite for Feature 2: Verification Photo Enrolment.
 *
 * Rules:
 * - Refuses to run unless DB_HOST is localhost or 127.0.0.1 and NODE_ENV is not production.
 * - Uses fixture ids that sort below real ids (tbtstph01, etc.).
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

// ── Environment Guard ────────────────────────────────────────────────────────
const dbHost = process.env.DB_HOST || 'localhost';
const isLocalDb = dbHost === 'localhost' || dbHost === '127.0.0.1';
const isDev = process.env.NODE_ENV !== 'production';

if (!isLocalDb || !isDev) {
  console.error('❌ Refusing to run tests: DB_HOST must be localhost/127.0.0.1 and NODE_ENV must not be production.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

const FIXTURE_USER = 'tbtstph01';
const FIXTURE_USER_NO_MOD = 'tbtstph02';
let FIXTURE_ADMIN_ID = null;
let FIXTURE_OFFICE_ID = null;

let server = null;
let baseUrl = '';

async function api(path, { method = 'GET', token = null, body = null, headers = {} } = {}) {
  const reqHeaders = { ...headers };
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    reqHeaders['Content-Type'] = 'application/json';
  }
  if (token) reqHeaders['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: reqHeaders,
    body: body ? (typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body) : undefined,
  });

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, headers: res.headers, body: json, rawText: text };
  } else {
    const arrayBuffer = await res.arrayBuffer();
    return { status: res.status, headers: res.headers, buffer: Buffer.from(arrayBuffer) };
  }
}

function generateDescriptor(seed = 1) {
  const arr = new Array(128);
  for (let i = 0; i < 128; i++) {
    arr[i] = Math.sin(seed * (i + 1) * 0.1) * 0.1;
  }
  return arr;
}

const OFFICE_LAT = 12.9715987;
const OFFICE_LNG = 77.5945627;

async function runTests() {
  console.log('🧪 Starting Feature 2 Photo Enrolment Tests...\n');
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

    // Admin fixture
    const [adminResult] = await pool.query(
      `INSERT INTO admins (name, email, password, role, is_active, created_at)
       VALUES ('Photo Fixture Admin', 'photo_admin@test.com', ?, 'admin', 1, ?)`,
      [hashedPassword, now]
    );
    FIXTURE_ADMIN_ID = adminResult.insertId;

    // Site user with Attendance
    await pool.query(
      `INSERT INTO site_users (user_id, fullname, email, password, module_access, is_active, created_at)
       VALUES (?, 'Photo Test User', 'photo_user@test.com', ?, ?, 1, ?)`,
      [FIXTURE_USER, hashedPassword, JSON.stringify(['Attendance']), now]
    );

    // Site user without Attendance
    await pool.query(
      `INSERT INTO site_users (user_id, fullname, email, password, module_access, is_active, created_at)
       VALUES (?, 'No Attendance User', 'no_att@test.com', ?, ?, 1, ?)`,
      [FIXTURE_USER_NO_MOD, hashedPassword, JSON.stringify(['Products']), now]
    );

    // Fixture Office
    const [officeResult] = await pool.query(
      `INSERT INTO attendance_offices
        (name, lat, lng, radius_m, accuracy_max_m, created_at, updated_at)
       VALUES ('Photo Test Office', ?, ?, 150, 50, ?, ?)`,
      [OFFICE_LAT, OFFICE_LNG, now, now]
    );
    FIXTURE_OFFICE_ID = officeResult.insertId;

    // Profile for user (linked to office, consent given)
    await pool.query(
      `INSERT INTO attendance_profiles (user_id, office_id, consent_at, consent_version, created_at, updated_at)
       VALUES (?, ?, ?, '1.0', ?, ?)`,
      [FIXTURE_USER, FIXTURE_OFFICE_ID, now, now, now]
    );

    const adminToken = jwt.sign({ id: FIXTURE_ADMIN_ID, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
    const employeeToken = jwt.sign({ userId: FIXTURE_USER, type: 'site_user' }, JWT_SECRET, { expiresIn: '1h' });

    // 1. Employee token rejected on photo endpoints
    {
      const resPost = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'POST',
        token: employeeToken,
        body: { photo: 'dGVzdA==', descriptors: [generateDescriptor(1)], consentAttested: true },
      });
      const resGet = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'GET',
        token: employeeToken,
      });
      const resDel = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'DELETE',
        token: employeeToken,
      });

      record('1. Employee token rejected on all photo routes', resPost.status === 401 && resGet.status === 401 && resDel.status === 401);
    }

    // 2. Missing consentAttested rejected
    {
      const jpegBuf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
      const res = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'POST',
        token: adminToken,
        body: { photo: jpegBuf.toString('base64'), descriptors: [generateDescriptor(1)], consentAttested: false },
      });
      record('2. Missing consentAttested rejected (400)', res.status === 400);
    }

    // 3. User without Attendance module rejected
    {
      const jpegBuf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
      const res = await api(`/api/attendance/admin/employees/${FIXTURE_USER_NO_MOD}/photo`, {
        method: 'POST',
        token: adminToken,
        body: { photo: jpegBuf.toString('base64'), descriptors: [generateDescriptor(1)], consentAttested: true },
      });
      record('3. Employee without Attendance module access rejected (400)', res.status === 400);
    }

    // 4. Text file renamed .jpg rejected (invalid magic bytes)
    {
      const fakeJpg = Buffer.from('This is a text file not a real jpeg image');
      const res = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'POST',
        token: adminToken,
        body: { photo: fakeJpg.toString('base64'), descriptors: [generateDescriptor(1)], consentAttested: true },
      });
      record('4. Text file renamed .jpg rejected by signature check (400)', res.status === 400);
    }

    // 5. 61 kB photo rejected
    {
      const largeBuf = Buffer.alloc(61000, 0xAA);
      largeBuf[0] = 0xFF; largeBuf[1] = 0xD8; largeBuf[2] = 0xFF; // JPEG header but 61KB
      const res = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'POST',
        token: adminToken,
        body: { photo: largeBuf.toString('base64'), descriptors: [generateDescriptor(1)], consentAttested: true },
      });
      record('5. 61 KB photo rejected with exact 413-style 400 message',
        res.status === 400 && res.body?.message === 'Photo is too large, maximum 60 KB after compression',
        res.body?.message
      );
    }

    // 6. Valid JPEG upload succeeds
    const validJpegBytes = Buffer.concat([
      Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]),
      Buffer.alloc(200, 0x12)
    ]);
    const validDescriptor = generateDescriptor(10);
    let postResponseBodyText = '';

    {
      const res = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'POST',
        token: adminToken,
        body: {
          photo: validJpegBytes.toString('base64'),
          descriptors: [validDescriptor],
          consentAttested: true,
        },
      });

      postResponseBodyText = res.rawText || JSON.stringify(res.body);

      const pass =
        res.status === 200 &&
        res.body?.success === true &&
        res.body?.data?.userId === FIXTURE_USER &&
        res.body?.data?.enrolSource === 'PHOTO' &&
        res.body?.data?.hasPhoto === true &&
        Boolean(res.body?.data?.enrolledAt);

      record('6. Valid JPEG photo enrolment succeeds', pass, JSON.stringify(res.body?.data));
    }

    // 7. GET photo returns identical bytes
    {
      const res = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'GET',
        token: adminToken,
      });

      const pass =
        res.status === 200 &&
        res.headers.get('content-type') === 'image/jpeg' &&
        res.headers.get('cache-control') === 'no-store' &&
        res.headers.get('x-content-type-options') === 'nosniff' &&
        res.buffer &&
        res.buffer.equals(validJpegBytes);

      record('7. GET photo returns identical decrypted bytes with security headers', pass);
    }

    // 8. Later check-in with matching descriptor passes
    {
      // Request challenge
      const chalRes = await api('/api/attendance/challenge', {
        method: 'POST',
        token: employeeToken,
        body: { lat: OFFICE_LAT, lng: OFFICE_LNG, accuracy: 10, purpose: 'checkin' },
      });

      const challengeId = chalRes.body?.data?.challengeId;
      assert(challengeId, 'Expected challengeId');

      // Wait 2.1s to pass CHALLENGE_MIN_MS
      await new Promise((r) => setTimeout(r, 2100));

      // Check-in with matching descriptors
      const d1 = validDescriptor;
      const d2 = validDescriptor.map((v, i) => v + 0.005 * Math.sin(i));
      const d3 = validDescriptor.map((v, i) => v - 0.005 * Math.cos(i));

      const checkInRes = await api('/api/attendance/check-in', {
        method: 'POST',
        token: employeeToken,
        body: {
          challengeId,
          lat: OFFICE_LAT,
          lng: OFFICE_LNG,
          accuracy: 10,
          descriptors: [d1, d2, d3],
        },
      });

      record('8. Later check-in with matching descriptor passes (200)', checkInRes.status === 200, `Status: ${checkInRes.status}`);
    }

    // 9. PNG upload succeeds
    const validPngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      Buffer.alloc(100, 0x42)
    ]);
    {
      const res = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'POST',
        token: adminToken,
        body: {
          photo: validPngBytes.toString('base64'),
          descriptors: [validDescriptor],
          consentAttested: true,
        },
      });
      const getRes = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'GET',
        token: adminToken,
      });

      const pass =
        res.status === 200 &&
        getRes.status === 200 &&
        getRes.headers.get('content-type') === 'image/png' &&
        getRes.buffer &&
        getRes.buffer.equals(validPngBytes);

      record('9. PNG photo upload and retrieval succeeds with image/png', pass);
    }

    // 10. Audit log row has no photo, descriptors, or template
    {
      const [logs] = await pool.query(
        `SELECT * FROM attendance_audit_log WHERE entity_type = 'employee' AND entity_id = ? AND action = 'enrol_photo' ORDER BY id DESC LIMIT 1`,
        [FIXTURE_USER]
      );

      const logRow = logs[0];
      const afterJsonStr = typeof logRow?.after_json === 'string' ? logRow.after_json : JSON.stringify(logRow?.after_json);

      const hasNoPhotoData =
        logRow &&
        !afterJsonStr.includes(validJpegBytes.toString('base64')) &&
        !afterJsonStr.includes(validPngBytes.toString('base64')) &&
        !afterJsonStr.includes('descriptors') &&
        !afterJsonStr.includes('template');

      record('10. Audit log row for enrol_photo contains no photo or descriptor data', hasNoPhotoData, afterJsonStr);

      // 10b. Audit log row for view_photo written on GET photo
      await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'GET',
        token: adminToken,
      });

      const [viewLogs] = await pool.query(
        `SELECT * FROM attendance_audit_log WHERE entity_type = 'employee' AND entity_id = ? AND action = 'view_photo' ORDER BY id DESC LIMIT 1`,
        [FIXTURE_USER]
      );
      const viewLog = viewLogs[0];
      const viewPass = Boolean(viewLog && viewLog.actor_admin_id === FIXTURE_ADMIN_ID);
      record('10b. Audit log row for view_photo written on GET photo', viewPass);
    }

    // 11. No JSON response leaks photo data or 'photo_enc'
    {
      const employeesRes = await api('/api/attendance/admin/employees', { token: adminToken });
      const timelineRes = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/timeline`, { token: adminToken });
      const statusRes = await api('/api/attendance/me/status', { token: employeeToken });

      const responsesToCheck = [
        postResponseBodyText,
        employeesRes.rawText || '',
        timelineRes.rawText || '',
        statusRes.rawText || '',
      ];

      let leaked = false;
      for (const text of responsesToCheck) {
        if (text.includes(validJpegBytes.toString('base64')) || text.includes(validPngBytes.toString('base64')) || text.includes('photo_enc')) {
          leaked = true;
          break;
        }
      }

      record('11. Zero JSON response leaks photo data or photo_enc', !leaked);
    }

    // 12. GET /admin/employees includes hasPhoto and enrolSource
    {
      const res = await api('/api/attendance/admin/employees', { token: adminToken });
      const emp = res.body?.data?.employees?.find((e) => e.userId === FIXTURE_USER);

      const pass =
        res.status === 200 &&
        emp &&
        emp.hasPhoto === true &&
        emp.enrolSource === 'PHOTO';

      record('12. GET /admin/employees exposes hasPhoto: true and enrolSource: PHOTO', pass, JSON.stringify(emp));
    }

    // 13. DELETE /admin/employees/:userId/photo removes photo only (template stays)
    {
      const delRes = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'DELETE',
        token: adminToken,
      });

      const getPhotoRes = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'GET',
        token: adminToken,
      });

      // Employee list should now show hasPhoto: false but faceEnrolled: true
      const empRes = await api('/api/attendance/admin/employees', { token: adminToken });
      const emp = empRes.body?.data?.employees?.find((e) => e.userId === FIXTURE_USER);

      const pass =
        delRes.status === 200 &&
        getPhotoRes.status === 404 &&
        emp &&
        emp.hasPhoto === false &&
        emp.faceEnrolled === true;

      record('13. DELETE photo removes photo only (GET photo returns 404, template preserved)', pass);
    }

    // 14. DELETE /admin/employees/:userId/face removes template AND photo
    {
      // First re-upload photo
      await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'POST',
        token: adminToken,
        body: { photo: validJpegBytes.toString('base64'), descriptors: [validDescriptor], consentAttested: true },
      });

      // Now call DELETE face
      const delFaceRes = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/face`, {
        method: 'DELETE',
        token: adminToken,
      });

      const getPhotoRes = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'GET',
        token: adminToken,
      });

      const empRes = await api('/api/attendance/admin/employees', { token: adminToken });
      const emp = empRes.body?.data?.employees?.find((e) => e.userId === FIXTURE_USER);

      const pass =
        delFaceRes.status === 200 &&
        getPhotoRes.status === 404 &&
        emp &&
        emp.hasPhoto === false &&
        emp.faceEnrolled === false;

      record('14. DELETE face removes template AND photo', pass);
    }

    // 15 & 16. LIVE template safeguard
    {
      const liveDesc = generateDescriptor(99);
      const encLive = encryptEmbedding(liveDesc);
      await pool.query(
        `UPDATE attendance_profiles SET face_template = ?, face_enrolled_at = NOW(), enrol_source = 'LIVE' WHERE user_id = ?`,
        [encLive, FIXTURE_USER]
      );

      // Call POST photo with replaceTemplate omitted
      const resPreserve = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'POST',
        token: adminToken,
        body: {
          photo: validJpegBytes.toString('base64'),
          descriptors: [validDescriptor],
          consentAttested: true,
        },
      });

      const passPreserveResponse =
        resPreserve.status === 200 &&
        resPreserve.body?.data?.templateUpdated === false &&
        resPreserve.body?.data?.enrolSource === 'LIVE' &&
        resPreserve.body?.data?.hasPhoto === true;

      const [profRowPreserve] = await pool.query(
        `SELECT face_template, enrol_source, photo_enc FROM attendance_profiles WHERE user_id = ?`,
        [FIXTURE_USER]
      );
      const passPreserveDb =
        profRowPreserve[0]?.enrol_source === 'LIVE' &&
        profRowPreserve[0]?.face_template.equals(encLive) &&
        Boolean(profRowPreserve[0]?.photo_enc);

      record('15. Photo upload preserves LIVE template when replaceTemplate omitted (templateUpdated=false)', passPreserveResponse && passPreserveDb);

      // Call POST photo with replaceTemplate: true
      const resReplace = await api(`/api/attendance/admin/employees/${FIXTURE_USER}/photo`, {
        method: 'POST',
        token: adminToken,
        body: {
          photo: validPngBytes.toString('base64'),
          descriptors: [validDescriptor],
          consentAttested: true,
          replaceTemplate: true,
        },
      });

      const passReplaceResponse =
        resReplace.status === 200 &&
        resReplace.body?.data?.templateUpdated === true &&
        resReplace.body?.data?.enrolSource === 'PHOTO';

      const [profRowReplace] = await pool.query(
        `SELECT face_template, enrol_source FROM attendance_profiles WHERE user_id = ?`,
        [FIXTURE_USER]
      );
      const passReplaceDb =
        profRowReplace[0]?.enrol_source === 'PHOTO' &&
        !profRowReplace[0]?.face_template.equals(encLive);

      record('16. Photo upload replaces LIVE template when replaceTemplate: true (templateUpdated=true)', passReplaceResponse && passReplaceDb);
    }

  } catch (err) {
    console.error('❌ Test failed with error:', err);
    record('Fatal test error', false, err.message);
  } finally {
    console.log('\n🧹 Cleaning up Photo test fixtures...');
    try {
      await pool.query('DELETE FROM attendance_attempts WHERE user_id IN (?, ?)', [FIXTURE_USER, FIXTURE_USER_NO_MOD]);
      await pool.query('DELETE FROM attendance_challenges WHERE user_id IN (?, ?)', [FIXTURE_USER, FIXTURE_USER_NO_MOD]);
      await pool.query('DELETE FROM attendance_intervals WHERE record_id IN (SELECT id FROM attendance_records WHERE user_id = ?)', [FIXTURE_USER]);
      await pool.query('DELETE FROM attendance_presence WHERE user_id IN (?, ?)', [FIXTURE_USER, FIXTURE_USER_NO_MOD]);
      await pool.query('DELETE FROM attendance_records WHERE user_id IN (?, ?)', [FIXTURE_USER, FIXTURE_USER_NO_MOD]);
      await pool.query('DELETE FROM attendance_profiles WHERE user_id IN (?, ?)', [FIXTURE_USER, FIXTURE_USER_NO_MOD]);
      await pool.query('DELETE FROM attendance_audit_log WHERE entity_id IN (?, ?)', [FIXTURE_USER, FIXTURE_USER_NO_MOD]);
      if (FIXTURE_OFFICE_ID) {
        await pool.query('DELETE FROM attendance_offices WHERE id = ?', [FIXTURE_OFFICE_ID]);
      }
      await pool.query('DELETE FROM site_users WHERE user_id IN (?, ?)', [FIXTURE_USER, FIXTURE_USER_NO_MOD]);
      if (FIXTURE_ADMIN_ID) {
        await pool.query('DELETE FROM admins WHERE id = ?', [FIXTURE_ADMIN_ID]);
      }
      console.log('✅ Fixtures cleaned up cleanly.');
    } catch (cleanErr) {
      console.warn('⚠️ Cleanup warning:', cleanErr.message);
    }

    if (server) server.close();
    await pool.end();

    const failed = results.filter((r) => !r.passed);
    console.log(`\n========================================`);
    console.log(`Photo Test Results: ${results.length - failed.length}/${results.length} passed`);
    console.log(`========================================\n`);

    if (failed.length > 0) process.exit(1);
    else process.exit(0);
  }
}

runTests();
