const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime } = require('../utils/time');

function parseOffice(row) {
  if (!row) return null;
  let ipAllowlist = row.ip_allowlist;
  if (typeof ipAllowlist === 'string') {
    try {
      ipAllowlist = JSON.parse(ipAllowlist);
    } catch {
      // keep as string or null
    }
  }
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
    ip_allowlist: ipAllowlist,
  };
}

const SELECT = `
  id, name, lat, lng, radius_m, accuracy_max_m, ip_allowlist, require_both,
  TIME_FORMAT(shift_start, '%H:%i:%s') AS shift_start,
  TIME_FORMAT(shift_end, '%H:%i:%s') AS shift_end,
  grace_minutes, outside_tolerance_minutes, short_outing_allowance_minutes,
  heartbeat_seconds, reverify_count,
  ${sqlUtc('created_at')}, ${sqlUtc('updated_at')}
`;

const AttendanceOfficeModel = {
  async findById(id) {
    const [rows] = await pool.query(
      `SELECT ${SELECT} FROM attendance_offices WHERE id = ?`,
      [id]
    );
    return parseOffice(rows[0]);
  },

  async findAll() {
    const [rows] = await pool.query(
      `SELECT ${SELECT} FROM attendance_offices ORDER BY id ASC`
    );
    return rows.map(parseOffice);
  },

  async create(data) {
    const now = toUtcDateTime();
    const ipAllowlistJson = data.ip_allowlist ? JSON.stringify(data.ip_allowlist) : null;
    const [result] = await pool.query(
      `INSERT INTO attendance_offices
        (name, lat, lng, radius_m, accuracy_max_m, ip_allowlist, require_both,
         shift_start, shift_end, grace_minutes, outside_tolerance_minutes,
         short_outing_allowance_minutes, heartbeat_seconds, reverify_count,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.name,
        data.lat,
        data.lng,
        data.radius_m || 150,
        data.accuracy_max_m || 50,
        ipAllowlistJson,
        data.require_both ? 1 : 0,
        data.shift_start || '09:30:00',
        data.shift_end || '18:30:00',
        data.grace_minutes != null ? data.grace_minutes : 10,
        data.outside_tolerance_minutes != null ? data.outside_tolerance_minutes : 10,
        data.short_outing_allowance_minutes != null ? data.short_outing_allowance_minutes : 30,
        data.heartbeat_seconds != null ? data.heartbeat_seconds : 60,
        data.reverify_count != null ? data.reverify_count : 2,
        now,
        now,
      ]
    );
    return result.insertId;
  },

  async update(id, data) {
    const setClauses = ['updated_at = UTC_TIMESTAMP()'];
    const params = [];

    if (data.name !== undefined) { setClauses.push('name = ?'); params.push(data.name); }
    if (data.lat !== undefined) { setClauses.push('lat = ?'); params.push(data.lat); }
    if (data.lng !== undefined) { setClauses.push('lng = ?'); params.push(data.lng); }
    if (data.radius_m !== undefined) { setClauses.push('radius_m = ?'); params.push(data.radius_m); }
    if (data.accuracy_max_m !== undefined) { setClauses.push('accuracy_max_m = ?'); params.push(data.accuracy_max_m); }
    if (data.ip_allowlist !== undefined) {
      setClauses.push('ip_allowlist = ?');
      params.push(data.ip_allowlist ? JSON.stringify(data.ip_allowlist) : null);
    }
    if (data.require_both !== undefined) { setClauses.push('require_both = ?'); params.push(data.require_both ? 1 : 0); }
    if (data.shift_start !== undefined) { setClauses.push('shift_start = ?'); params.push(data.shift_start); }
    if (data.shift_end !== undefined) { setClauses.push('shift_end = ?'); params.push(data.shift_end); }
    if (data.grace_minutes !== undefined) { setClauses.push('grace_minutes = ?'); params.push(data.grace_minutes); }
    if (data.outside_tolerance_minutes !== undefined) { setClauses.push('outside_tolerance_minutes = ?'); params.push(data.outside_tolerance_minutes); }
    if (data.short_outing_allowance_minutes !== undefined) { setClauses.push('short_outing_allowance_minutes = ?'); params.push(data.short_outing_allowance_minutes); }
    if (data.heartbeat_seconds !== undefined) { setClauses.push('heartbeat_seconds = ?'); params.push(data.heartbeat_seconds); }
    if (data.reverify_count !== undefined) { setClauses.push('reverify_count = ?'); params.push(data.reverify_count); }

    params.push(id);
    const [result] = await pool.query(
      `UPDATE attendance_offices SET ${setClauses.join(', ')} WHERE id = ?`,
      params
    );
    return result.affectedRows > 0;
  },

  async delete(id) {
    const [result] = await pool.query('DELETE FROM attendance_offices WHERE id = ?', [id]);
    return result.affectedRows > 0;
  },

  async countReferences(id) {
    const [profileRows] = await pool.query(
      'SELECT COUNT(*) AS count FROM attendance_profiles WHERE office_id = ?',
      [id]
    );
    const [recordRows] = await pool.query(
      'SELECT COUNT(*) AS count FROM attendance_records WHERE office_id = ?',
      [id]
    );
    return {
      profiles: Number(profileRows[0]?.count) || 0,
      records: Number(recordRows[0]?.count) || 0,
      total: (Number(profileRows[0]?.count) || 0) + (Number(recordRows[0]?.count) || 0),
    };
  },
};

module.exports = AttendanceOfficeModel;
