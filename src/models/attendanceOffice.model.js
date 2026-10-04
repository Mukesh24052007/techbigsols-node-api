const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime } = require('../utils/time');

function parseOffice(row) {
  if (!row) return null;
  return {
    ...row,
    lat: row.lat != null ? Number(row.lat) : null,
    lng: row.lng != null ? Number(row.lng) : null,
    radius_m: Number(row.radius_m),
    accuracy_max_m: Number(row.accuracy_max_m),
    require_both: Boolean(row.require_both),
    grace_minutes: Number(row.grace_minutes),
    outside_tolerance_minutes: Number(row.outside_tolerance_minutes),
    short_outing_allowance_minutes: Number(row.short_outing_allowance_minutes != null ? row.short_outing_allowance_minutes : 30),
    heartbeat_seconds: Number(row.heartbeat_seconds),
    reverify_count: Number(row.reverify_count),
  };
}

const AttendanceOfficeModel = {
  async findById(id) {
    const [rows] = await pool.query(
      `SELECT id, name, lat, lng, radius_m, accuracy_max_m, ip_allowlist, require_both,
              TIME_FORMAT(shift_start, '%H:%i:%s') AS shift_start,
              TIME_FORMAT(shift_end, '%H:%i:%s') AS shift_end,
              grace_minutes, outside_tolerance_minutes, short_outing_allowance_minutes,
              heartbeat_seconds, reverify_count,
              ${sqlUtc('created_at')}, ${sqlUtc('updated_at')}
       FROM attendance_offices WHERE id = ?`,
      [id]
    );
    return parseOffice(rows[0]);
  },
};

module.exports = AttendanceOfficeModel;
