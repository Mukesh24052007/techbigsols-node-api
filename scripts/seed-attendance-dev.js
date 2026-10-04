'use strict';

require('dotenv').config();
const { pool } = require('../src/config/db');
const { toUtcDateTime } = require('../src/utils/time');

// Safety guard: refuse to run against anything other than local DB
const dbHost = (process.env.DB_HOST || '').toLowerCase();
if (dbHost !== 'localhost' && dbHost !== '127.0.0.1') {
  console.error(`Refusing to run seed against DB_HOST "${dbHost}". Only localhost/127.0.0.1 is allowed.`);
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run seed in production NODE_ENV.');
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {};
  for (const arg of args) {
    const match = arg.match(/^--([a-zA-Z0-9_-]+)=(.*)$/);
    if (match) {
      params[match[1]] = match[2];
    }
  }
  return params;
}

async function run() {
  const params = parseArgs();

  const lat = parseFloat(params.lat);
  const lng = parseFloat(params.lng);
  const radius = params.radius !== undefined ? parseInt(params.radius, 10) : 200;
  const userId = params.user ? String(params.user).trim() : null;

  if (isNaN(lat) || isNaN(lng) || !userId) {
    console.log(`
Usage: node scripts/seed-attendance-dev.js --lat=<latitude> --lng=<longitude> [--radius=200] --user=<site_user_id>

Example:
  node scripts/seed-attendance-dev.js --lat=12.9716 --lng=77.5946 --radius=200 --user=tb001
`);
    process.exit(1);
  }

  const conn = await pool.getConnection();
  try {
    const now = toUtcDateTime();

    // 1. Verify user exists in site_users
    const [users] = await conn.query('SELECT user_id, fullname, email FROM site_users WHERE user_id = ?', [userId]);
    if (!users.length) {
      console.error(`User with user_id "${userId}" not found in site_users.`);
      process.exit(1);
    }
    const user = users[0];

    // 2. Upsert "Dev Office"
    const [existingOffices] = await conn.query(
      'SELECT id FROM attendance_offices WHERE name = ? LIMIT 1',
      ['Dev Office']
    );

    let officeId;
    if (existingOffices.length) {
      officeId = existingOffices[0].id;
      await conn.query(
        `UPDATE attendance_offices
         SET lat = ?, lng = ?, radius_m = ?, accuracy_max_m = 100, updated_at = ?
         WHERE id = ?`,
        [lat, lng, radius, now, officeId]
      );
      console.log(`Updated existing Dev Office (id: ${officeId})`);
    } else {
      const [res] = await conn.query(
        `INSERT INTO attendance_offices
          (name, lat, lng, radius_m, accuracy_max_m, ip_allowlist, require_both,
           shift_start, shift_end, grace_minutes, outside_tolerance_minutes,
           short_outing_allowance_minutes, heartbeat_seconds, reverify_count,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, 100, NULL, 0, '09:30:00', '18:30:00', 10, 10, 30, 60, 2, ?, ?)`,
        ['Dev Office', lat, lng, radius, now, now]
      );
      officeId = res.insertId;
      console.log(`Created Dev Office (id: ${officeId})`);
    }

    // 3. Upsert profile for the user
    await conn.query(
      `INSERT INTO attendance_profiles
        (user_id, office_id, shift_start, shift_end, created_at, updated_at)
       VALUES (?, ?, '09:30:00', '18:30:00', ?, ?)
       ON DUPLICATE KEY UPDATE
         office_id = VALUES(office_id),
         shift_start = VALUES(shift_start),
         shift_end = VALUES(shift_end),
         updated_at = VALUES(updated_at)`,
      [userId, officeId, now, now]
    );

    console.log(`\nAttendance Dev Seed Complete:`);
    console.log(`- Office ID: ${officeId} ("Dev Office")`);
    console.log(`- Coordinates: (${lat}, ${lng})`);
    console.log(`- Radius: ${radius}m | Max Accuracy: 100m`);
    console.log(`- User: ${user.user_id} (${user.fullname} <${user.email}>)`);
    console.log(`- Shift: 09:30:00 - 18:30:00\n`);
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Seed error:', err.message);
  process.exit(1);
});
