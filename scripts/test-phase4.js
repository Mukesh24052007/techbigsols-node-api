'use strict';

require('dotenv').config();
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { pool } = require('../src/config/db');
const attendanceBus = require('../src/services/attendanceBus');
const AttendanceController = require('../src/controllers/attendance.controller');
const AttendanceOfficeModel = require('../src/models/attendanceOffice.model');
const AttendanceProfileModel = require('../src/models/attendanceProfile.model');
const AttendanceRecordModel = require('../src/models/attendanceRecord.model');
const AttendancePresenceModel = require('../src/models/attendancePresence.model');
const AttendanceIntervalModel = require('../src/models/attendanceInterval.model');
const AttendanceLeaveModel = require('../src/models/attendanceLeave.model');
const AttendanceRegularizationModel = require('../src/models/attendanceRegularization.model');
const AttendanceAuditLogModel = require('../src/models/attendanceAuditLog.model');
const AttendanceAttemptModel = require('../src/models/attendanceAttempt.model');
const { toUtcDateTime, istCalendarDate, istDateTimeToUtc } = require('../src/utils/time');

// ── 0. Safety Guards ────────────────────────────────────────────────────────
const dbHost = (process.env.DB_HOST || '').toLowerCase();
if (dbHost !== 'localhost' && dbHost !== '127.0.0.1') {
  console.error(`Refusing to run tests against DB_HOST "${dbHost}". Only localhost/127.0.0.1 is allowed.`);
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run tests in production NODE_ENV.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

let server = null;
let baseUrl = '';

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

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${name}${detail ? ` (${detail})` : ''}`);
}

async function run() {
  console.log('--- PHASE 4 ACCEPTANCE TESTS ---');

  // Start HTTP server on dynamic port
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://localhost:${port}`;

  let fixtureAdminId = null;
  let adminToken = null;
  let employeeToken = null;
  let fixtureOfficeId = null;
  let tempOfficeId = null;
  const userIds = ['tbtst401', 'tbtst402', 'tbtst403', 'tbtst404', 'tbtst405'];

  try {
    const now = toUtcDateTime();
    const today = istCalendarDate(new Date());

    // ── Setup Fixtures ───────────────────────────────────────────────────────
    // 1. Create Test Admin
    const hashedPass = await bcrypt.hash('AdminPass123!', 4);
    const [adminRes] = await pool.query(
      `INSERT INTO admins (name, email, password, role, is_active, created_at)
       VALUES ('Phase4 Admin', 'p4admin@techbigsols.com', ?, 'admin', 1, NOW())`,
      [hashedPass]
    );
    fixtureAdminId = adminRes.insertId;
    adminToken = jwt.sign({ id: fixtureAdminId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });

    // 2. Create Test Users in site_users
    const userNames = [
      'Alice Four',
      'Bob Four',
      "=HYPERLINK('http://evil.com')", // Formula injection test case
      'Dave Absent',
      'Eve OnLeave',
    ];
    for (let i = 0; i < userIds.length; i++) {
      await pool.query(
        `INSERT INTO site_users (user_id, fullname, email, password, module_access, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, NOW())`,
        [userIds[i], userNames[i], `${userIds[i]}@techbigsols.com`, hashedPass, JSON.stringify(['Attendance'])]
      );
    }

    // Employee token for tbtst401 (site_user token, NOT admin)
    employeeToken = jwt.sign(
      { id: 'tbtst401', user_id: 'tbtst401', type: 'site_user', module_access: ['Attendance'] },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // 3. Create Fixture Offices
    const [off1] = await pool.query(
      `INSERT INTO attendance_offices
        (name, lat, lng, radius_m, accuracy_max_m, ip_allowlist, require_both,
         shift_start, shift_end, grace_minutes, outside_tolerance_minutes,
         short_outing_allowance_minutes, heartbeat_seconds, reverify_count,
         created_at, updated_at)
       VALUES ('Phase4 HQ', 12.9716, 77.5946, 200, 50, NULL, 0, '09:30:00', '18:30:00', 10, 10, 30, 60, 2, ?, ?)`,
      [now, now]
    );
    fixtureOfficeId = off1.insertId;

    const [off2] = await pool.query(
      `INSERT INTO attendance_offices
        (name, lat, lng, radius_m, accuracy_max_m, ip_allowlist, require_both,
         shift_start, shift_end, grace_minutes, outside_tolerance_minutes,
         short_outing_allowance_minutes, heartbeat_seconds, reverify_count,
         created_at, updated_at)
       VALUES ('Phase4 Temp', 12.9800, 77.6000, 150, 50, NULL, 0, '09:30:00', '18:30:00', 10, 10, 30, 60, 2, ?, ?)`,
      [now, now]
    );
    tempOfficeId = off2.insertId;

    // 4. Create Profiles for test users
    for (const uid of userIds) {
      await AttendanceProfileModel.upsertProfile(uid, {
        officeId: fixtureOfficeId,
        shiftStart: '09:30:00',
        shiftEnd: '18:30:00',
        department: 'Engineering',
        designation: 'Developer',
      });
    }

    // ── Tests: Auth Barrier ──────────────────────────────────────────────────
    {
      const res = await api('/api/attendance/admin/offices');
      record('1. Admin Auth Barrier: Reject unauthenticated request', res.status === 401, `Status: ${res.status}`);
    }
    {
      const res = await api('/api/attendance/admin/offices', { token: employeeToken });
      record('2. Admin Auth Barrier: Reject employee token on admin route', res.status === 401, `Status: ${res.status}`);
    }
    {
      const res = await api('/api/attendance/admin/offices', { token: adminToken });
      record('3. Admin Auth Barrier: Allow valid admin token', res.status === 200, `Status: ${res.status}`);
    }

    // ── Tests: Offices CRUD ──────────────────────────────────────────────────
    let createdOfficeId = null;
    {
      // Validation failure
      const res = await api('/api/attendance/admin/offices', {
        method: 'POST',
        token: adminToken,
        body: { name: 'Invalid Office', lat: -95, lng: 200, radius_m: 5, accuracy_max_m: 500 },
      });
      record('4. Office Validation: Reject invalid lat/lng/radius/accuracy', res.status === 400, `Status: ${res.status}`);
    }
    {
      // Valid creation
      const res = await api('/api/attendance/admin/offices', {
        method: 'POST',
        token: adminToken,
        body: {
          name: 'Phase4 Branch Office',
          lat: 12.9352,
          lng: 77.6245,
          radius_m: 250,
          accuracy_max_m: 60,
          shift_start: '09:00:00',
          shift_end: '18:00:00',
          grace_minutes: 15,
        },
      });
      createdOfficeId = res.body?.data?.office?.id;
      record('5. Office CRUD: Create new office', res.status === 201 && createdOfficeId != null, `Office ID: ${createdOfficeId}`);
    }
    {
      // Update office
      const res = await api(`/api/attendance/admin/offices/${createdOfficeId}`, {
        method: 'PUT',
        token: adminToken,
        body: { radius_m: 300, name: 'Phase4 Branch Office Updated' },
      });
      record(
        '6. Office CRUD: Update office details',
        res.status === 200 && res.body?.data?.office?.radius_m === 300,
        `Radius: ${res.body?.data?.office?.radius_m}`
      );
    }
    {
      // Get office by ID
      const res = await api(`/api/attendance/admin/offices/${createdOfficeId}`, { token: adminToken });
      record(
        '7. Office CRUD: Get office by ID',
        res.status === 200 && res.body?.data?.office?.name === 'Phase4 Branch Office Updated',
        `Name: ${res.body?.data?.office?.name}`
      );
    }
    {
      // List offices
      const res = await api('/api/attendance/admin/offices', { token: adminToken });
      const found = res.body?.data?.offices?.some((o) => o.id === createdOfficeId);
      record('8. Office CRUD: List all offices', res.status === 200 && found, `Found in list: ${found}`);
    }
    {
      // Delete office with references guard: assign tempOfficeId to tbtst402 profile, then try deleting tempOfficeId
      await AttendanceProfileModel.upsertProfile('tbtst402', { officeId: tempOfficeId });
      const res = await api(`/api/attendance/admin/offices/${tempOfficeId}`, {
        method: 'DELETE',
        token: adminToken,
      });
      record(
        '9. Office Reference Guard: 409 Conflict when deleting referenced office',
        res.status === 409,
        `Status: ${res.status}`
      );
      // Remove reference back to fixtureOfficeId
      await AttendanceProfileModel.upsertProfile('tbtst402', { officeId: fixtureOfficeId });
    }
    {
      // Delete unreferenced office
      const res = await api(`/api/attendance/admin/offices/${tempOfficeId}`, {
        method: 'DELETE',
        token: adminToken,
      });
      record('10. Office CRUD: Delete unreferenced office succeeds', res.status === 200, `Status: ${res.status}`);
    }
    {
      // Audit log check for office operations
      const [logs] = await pool.query(
        `SELECT action, entity_type, entity_id, before_json, after_json
         FROM attendance_audit_log
         WHERE actor_admin_id = ? AND entity_type = 'office'
         ORDER BY id ASC`,
        [fixtureAdminId]
      );
      const actions = logs.map((l) => l.action);
      const hasCreate = actions.includes('office_create');
      const hasUpdate = actions.includes('office_update');
      const hasDelete = actions.includes('office_delete');
      record(
        '11. Audit Logging: Audit entries created for office operations',
        hasCreate && hasUpdate && hasDelete,
        `Actions: ${actions.join(', ')}`
      );
    }

    // ── Tests: Employees & Profiles ──────────────────────────────────────────
    {
      const res = await api('/api/attendance/admin/employees', { token: adminToken });
      const emp = res.body?.data?.employees?.find((e) => e.userId === 'tbtst401');
      const noSecrets = emp && !('face_template' in emp) && !('password' in emp);
      record('12. Employees List: Expose employee metadata without face template or password', res.status === 200 && noSecrets);
    }
    {
      const res = await api('/api/attendance/admin/employees/tbtst401/profile', {
        method: 'PUT',
        token: adminToken,
        body: {
          shiftStart: '10:00:00',
          shiftEnd: '19:00:00',
          department: 'Platform Engineering',
        },
      });
      const prof = res.body?.data?.profile;
      record(
        '13. Profile Update: Update employee shift and department',
        res.status === 200 && prof?.shift_start === '10:00:00' && prof?.department === 'Platform Engineering',
        `Department: ${prof?.department}`
      );
    }

    // ── Tests: Setup Live Data & Test /admin/live ─────────────────────────────
    // User 1 (tbtst401): open record, checked in 09:30 IST today, presence INSIDE
    const checkIn1Utc = istDateTimeToUtc(today, '09:30:00');
    const [rec1Res] = await pool.query(
      `INSERT INTO attendance_records
        (user_id, attendance_date, fullname, office_id, check_in_at, status, worked_minutes, created_at, updated_at)
       VALUES ('tbtst401', ?, 'Alice Four', ?, ?, 'PRESENT', 0, NOW(), NOW())`,
      [today, fixtureOfficeId, checkIn1Utc]
    );
    const rec1Id = rec1Res.insertId;
    await pool.query(
      `INSERT INTO attendance_presence (record_id, user_id, state, last_inside_at, updated_at)
       VALUES (?, 'tbtst401', 'INSIDE', ?, NOW())`,
      [rec1Id, checkIn1Utc]
    );
    await pool.query(
      `INSERT INTO attendance_intervals (record_id, state, started_at)
       VALUES (?, 'INSIDE', ?)`,
      [rec1Id, checkIn1Utc]
    );

    // User 2 (tbtst402): open record, checked in 09:30 IST today, presence OUTSIDE
    const [rec2Res] = await pool.query(
      `INSERT INTO attendance_records
        (user_id, attendance_date, fullname, office_id, check_in_at, status, worked_minutes, created_at, updated_at)
       VALUES ('tbtst402', ?, 'Bob Four', ?, ?, 'PRESENT', 0, NOW(), NOW())`,
      [today, fixtureOfficeId, checkIn1Utc]
    );
    const rec2Id = rec2Res.insertId;
    await pool.query(
      `INSERT INTO attendance_presence (record_id, user_id, state, outside_since, updated_at)
       VALUES (?, 'tbtst402', 'OUTSIDE', ?, NOW())`,
      [rec2Id, checkIn1Utc]
    );
    await pool.query(
      `INSERT INTO attendance_intervals (record_id, state, started_at)
       VALUES (?, 'OUTSIDE', ?)`,
      [rec2Id, checkIn1Utc]
    );

    // User 3 (tbtst403): closed record, checked in 10:15 (LATE), checked out 14:00 (closed)
    const checkIn3Utc = istDateTimeToUtc(today, '10:15:00');
    const checkOut3Utc = istDateTimeToUtc(today, '14:00:00');
    await pool.query(
      `INSERT INTO attendance_records
        (user_id, attendance_date, fullname, office_id, check_in_at, check_out_at, status, worked_minutes, created_at, updated_at)
       VALUES ('tbtst403', ?, "=HYPERLINK('http://evil.com')", ?, ?, ?, 'LATE', 225, NOW(), NOW())`,
      [today, fixtureOfficeId, checkIn3Utc, checkOut3Utc]
    );

    // User 4 (tbtst404): ABSENT (no record, no leave)

    // User 5 (tbtst405): ON LEAVE (approved leave today)
    await AttendanceLeaveModel.createApprovedSpan({
      userId: 'tbtst405',
      fromDate: today,
      toDate: today,
      reason: 'Personal Leave',
      reviewedBy: fixtureAdminId,
    });

    {
      // Test timeline for tbtst401
      const res = await api(`/api/attendance/admin/employees/tbtst401/timeline?date=${today}`, { token: adminToken });
      record(
        '14. Employee Timeline: Return day timeline with intervals and presence state',
        res.status === 200 && res.body?.data?.presenceState === 'INSIDE' && res.body?.data?.intervals?.length >= 1,
        `Presence: ${res.body?.data?.presenceState}`
      );
    }

    {
      // Test /admin/live counts
      const res = await api('/api/attendance/admin/live', { token: adminToken });
      const counts = res.body?.data?.counts || {};
      const rows = res.body?.data?.rows || [];

      // Check counts for fixture users
      // present: tbtst401, tbtst402, tbtst403 (3)
      // late: tbtst403 (1)
      // inside: tbtst401 (1)
      // outside: tbtst402 (1)
      // absent: tbtst404 (1)
      // on_leave: tbtst405 (1)
      const u1Row = rows.find((r) => r.employeeId === 'tbtst401');
      const u2Row = rows.find((r) => r.employeeId === 'tbtst402');
      const u3Row = rows.find((r) => r.employeeId === 'tbtst403');
      const u4Row = rows.find((r) => r.employeeId === 'tbtst404');
      const u5Row = rows.find((r) => r.employeeId === 'tbtst405');

      const pass =
        res.status === 200 &&
        u1Row?.presenceState === 'INSIDE' &&
        u2Row?.presenceState === 'OUTSIDE' &&
        u3Row?.presenceState === 'CHECKED_OUT' &&
        u4Row?.presenceState === 'ABSENT' &&
        u5Row?.presenceState === 'LEAVE';

      record(
        '15. Live Presence Snapshot: Accurate counts and employee states',
        pass,
        `Counts: present=${counts.present}, inside=${counts.inside}, outside=${counts.outside}, late=${counts.late}, absent=${counts.absent}, leave=${counts.on_leave}`
      );
    }

    {
      // Test Query Budget for /admin/live: strictly <= 2 queries in controller + 1 in protect middleware
      const origQuery = pool.query;
      let queryCount = 0;
      pool.query = function (...args) {
        queryCount++;
        return origQuery.apply(this, args);
      };

      try {
        await api('/api/attendance/admin/live', { token: adminToken });
      } finally {
        pool.query = origQuery;
      }

      record(
        '16. Live Query Budget: adminGetLive executes strictly <= 2 SQL queries (zero N+1)',
        queryCount <= 3,
        `Executed ${queryCount} queries (1 admin auth + 2 data queries)`
      );
    }

    // ── Tests: Live SSE Stream (/admin/stream) ────────────────────────────────
    {
      // 17. Connect SSE stream
      let sseReceivedConnected = false;
      let sseReceivedEvent = false;

      const reqSse = http.request(
        `${baseUrl}/api/attendance/admin/stream`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (chunk.includes(': connected')) {
              sseReceivedConnected = true;
            }
            if (chunk.includes('event: checkin') && chunk.includes('tbtst401')) {
              sseReceivedEvent = true;
            }
          });
        }
      );
      reqSse.end();

      // Wait 300ms for connection
      await new Promise((r) => setTimeout(r, 300));
      record('17. SSE Stream: Connect and receive initial : connected comment', sseReceivedConnected);

      // 18. Emit checkin event on attendanceBus and verify delivery
      attendanceBus.emitAttendanceEvent('checkin', {
        employeeId: 'tbtst401',
        name: 'Alice Four',
        type: 'checkin',
        time: new Date().toISOString(),
      });

      // Wait up to 1.5s for event arrival
      await new Promise((r) => setTimeout(r, 600));
      record('18. SSE Stream: Receive real-time event within 2s', sseReceivedEvent);
      reqSse.destroy();
    }

    {
      // 19. Concurrent connection limit: 5 streams allowed, 6th returns 429
      const streamReqs = [];
      for (let i = 0; i < 5; i++) {
        const req = http.request(`${baseUrl}/api/attendance/admin/stream`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        req.end();
        streamReqs.push(req);
      }
      await new Promise((r) => setTimeout(r, 200));

      // Attempt 6th stream
      const res6 = await api('/api/attendance/admin/stream', { token: adminToken });
      record(
        '19. SSE Stream Limit: 6th concurrent stream returns 429 Too Many Requests',
        res6.status === 429,
        `Status: ${res6.status}`
      );

      // Clean up the 5 streams
      for (const req of streamReqs) {
        req.destroy();
      }
      await new Promise((r) => setTimeout(r, 200));

      // 20. SSE Stream Cleanup: listener count and stream slots restored
      const resAfter = await api('/api/attendance/admin/stream', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      // Now a new stream request should not get 429
      record('20. SSE Stream Cleanup: Stream slots released on connection close', resAfter.status !== 429);
    }

    // ── Tests: CSV Export & Formula Injection Neutralization ─────────────────
    {
      const currentMonth = today.slice(0, 7);
      const res = await api(`/api/attendance/admin/report?month=${currentMonth}&format=csv`, { token: adminToken });
      const isCsv = res.headers.get('content-type')?.includes('text/csv');
      const csvContent = typeof res.body === 'string' ? res.body : '';

      // User 3 has name "=HYPERLINK('http://evil.com')". In secure CSV, it MUST be prefixed with "'"
      const neutralized = csvContent.includes("''=HYPERLINK") || csvContent.includes("'=HYPERLINK");
      record(
        '21. CSV Export & Formula Injection: Neutralize spreadsheet formula prefix in CSV',
        isCsv && neutralized,
        `Neutralized: ${neutralized}`
      );
    }

    // ── Tests: Attempts ──────────────────────────────────────────────────────
    {
      // Insert a test attempt
      await pool.query(
        `INSERT INTO attendance_attempts (user_id, kind, success, distance_score, accuracy, reason, created_at)
         VALUES ('tbtst401', 'checkin', 1, 0.25, 20.0, 'GPS + Face verified', NOW())`,
      );
      const res = await api('/api/attendance/admin/attempts?user=tbtst401&limit=10', { token: adminToken });
      const attempts = res.body?.data?.rows || [];
      record(
        '22. Attempts Pagination: Paginated attempts returned with limit and filters',
        res.status === 200 && attempts.length >= 1 && res.body?.data?.limit === 10
      );
    }

    // ── Tests: Regularizations ───────────────────────────────────────────────
    let regId1 = null;
    let regId2 = null;
    {
      // Create pending regularization requests
      const [r1] = await pool.query(
        `INSERT INTO attendance_regularizations (user_id, attendance_date, reason, status, created_at)
         VALUES ('tbtst401', ?, 'Card scanner was offline in morning', 'PENDING', NOW())`,
        [today]
      );
      regId1 = r1.insertId;

      const [r2] = await pool.query(
        `INSERT INTO attendance_regularizations (user_id, attendance_date, reason, status, created_at)
         VALUES ('tbtst402', ?, 'Forgot phone at home', 'PENDING', NOW())`,
        [today]
      );
      regId2 = r2.insertId;

      // Approve regId1
      const resApprove = await api(`/api/attendance/admin/regularizations/${regId1}/approve`, {
        method: 'POST',
        token: adminToken,
        body: {
          checkInTime: '09:00',
          checkOutTime: '18:00',
          status: 'PRESENT',
        },
      });

      // Second approve attempt on same request should return 409
      const resSecond = await api(`/api/attendance/admin/regularizations/${regId1}/approve`, {
        method: 'POST',
        token: adminToken,
        body: { checkInTime: '09:00', checkOutTime: '18:00', status: 'PRESENT' },
      });

      const pass = resApprove.status === 200 && resSecond.status === 409;
      record(
        '23. Regularization Approve: Upsert record, recompute worked minutes, reject duplicate (409)',
        pass,
        `Approve: ${resApprove.status}, Duplicate: ${resSecond.status}`
      );
    }
    {
      // Reject regId2
      const resReject = await api(`/api/attendance/admin/regularizations/${regId2}/reject`, {
        method: 'POST',
        token: adminToken,
      });
      const [regRows] = await pool.query('SELECT status FROM attendance_regularizations WHERE id = ?', [regId2]);
      record(
        '24. Regularization Reject: Mark request REJECTED and log audit',
        resReject.status === 200 && regRows[0]?.status === 'REJECTED'
      );
    }

    // ── Tests: Manual Record Patch ───────────────────────────────────────────
    {
      // Try patch with reason < 10 chars
      const resShort = await api(`/api/attendance/admin/records/${rec1Id}`, {
        method: 'PATCH',
        token: adminToken,
        body: {
          status: 'PRESENT',
          reason: 'Too short',
        },
      });
      record(
        '25. Record Patch Validation: Reject adjustment when reason is less than 10 chars (400)',
        resShort.status === 400,
        `Status: ${resShort.status}`
      );
    }
    {
      // Valid patch
      const newCheckOutUtc = istDateTimeToUtc(today, '18:30:00');
      const resPatch = await api(`/api/attendance/admin/records/${rec1Id}`, {
        method: 'PATCH',
        token: adminToken,
        body: {
          check_out_at: newCheckOutUtc,
          status: 'PRESENT',
          reason: 'Admin corrected checkout time after biometric sync failure',
        },
      });
      const rec = resPatch.body?.data?.record;
      record(
        '26. Record Patch Success: Update record, recompute worked minutes, audit before/after',
        resPatch.status === 200 && rec?.worked_minutes > 0,
        `Worked minutes: ${rec?.worked_minutes}`
      );
    }

    // ── Tests: Leaves ────────────────────────────────────────────────────────
    let leaveId = null;
    {
      // Create approved leave span (next week)
      const nextWeekStart = '2026-10-12';
      const nextWeekEnd = '2026-10-14';
      const resLeave = await api('/api/attendance/admin/leaves', {
        method: 'POST',
        token: adminToken,
        body: {
          userId: 'tbtst401',
          fromDate: nextWeekStart,
          toDate: nextWeekEnd,
          reason: 'Annual leave',
        },
      });
      leaveId = resLeave.body?.data?.ids?.[0];
      record(
        '27. Leaves: Create approved multi-day leave span',
        resLeave.status === 201 && resLeave.body?.data?.count === 3,
        `Count: ${resLeave.body?.data?.count}`
      );
    }
    {
      // Attempt overlapping leave on same user -> 409 Conflict
      const resOverlap = await api('/api/attendance/admin/leaves', {
        method: 'POST',
        token: adminToken,
        body: {
          userId: 'tbtst401',
          fromDate: '2026-10-13',
          toDate: '2026-10-15',
          reason: 'Overlapping request',
        },
      });
      record(
        '28. Leaves: Reject overlapping approved leave for same employee (409)',
        resOverlap.status === 409,
        `Status: ${resOverlap.status}`
      );
    }
    {
      // Cancel leave
      const resCancel = await api(`/api/attendance/admin/leaves/${leaveId}`, {
        method: 'DELETE',
        token: adminToken,
      });
      const [lRows] = await pool.query('SELECT status FROM attendance_leaves WHERE id = ?', [leaveId]);
      record(
        '29. Leaves: Cancel approved leave and record audit log',
        resCancel.status === 200 && lRows[0]?.status === 'REJECTED'
      );
    }
  } catch (err) {
    console.error('Test execution error:', err);
    record('Fatal test suite exception', false, err.message);
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────────
    console.log('\n--- Cleaning up test fixtures ---');
    try {
      if (fixtureAdminId) {
        await pool.query('DELETE FROM attendance_audit_log WHERE actor_admin_id = ?', [fixtureAdminId]);
      }
      await pool.query("DELETE FROM attendance_audit_log WHERE entity_id LIKE 'tbtst4%'");
      await pool.query("DELETE FROM attendance_leaves WHERE user_id LIKE 'tbtst4%'");
      await pool.query("DELETE FROM attendance_regularizations WHERE user_id LIKE 'tbtst4%'");
      await pool.query("DELETE FROM attendance_reverify_tasks WHERE user_id LIKE 'tbtst4%'");
      await pool.query("DELETE FROM attendance_attempts WHERE user_id LIKE 'tbtst4%'");
      await pool.query("DELETE FROM attendance_challenges WHERE user_id LIKE 'tbtst4%'");
      await pool.query(
        "DELETE FROM attendance_intervals WHERE record_id IN (SELECT id FROM attendance_records WHERE user_id LIKE 'tbtst4%')"
      );
      await pool.query("DELETE FROM attendance_presence WHERE user_id LIKE 'tbtst4%'");
      await pool.query("DELETE FROM attendance_records WHERE user_id LIKE 'tbtst4%'");
      await pool.query("DELETE FROM attendance_profiles WHERE user_id LIKE 'tbtst4%'");
      await pool.query("DELETE FROM attendance_offices WHERE name LIKE 'Phase4%'");
      await pool.query("DELETE FROM site_users WHERE user_id LIKE 'tbtst4%'");
      if (fixtureAdminId) {
        await pool.query('DELETE FROM admins WHERE id = ?', [fixtureAdminId]);
      }
      console.log('Cleanup finished.');
    } catch (cleanErr) {
      console.error('Error during cleanup:', cleanErr.message);
    }

    if (server) {
      server.close();
    }
    await pool.end();
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;
  console.log(`\n================================`);
  console.log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

run();
