const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime } = require('../utils/time');

const AttendancePresenceModel = {
  async findByRecordId(recordId) {
    const [rows] = await pool.query(
      `SELECT record_id, user_id, state,
              ${sqlUtc('last_heartbeat_at')}, ${sqlUtc('last_inside_at')}, ${sqlUtc('outside_since')},
              last_lat, last_lng, last_accuracy, ${sqlUtc('updated_at')}
       FROM attendance_presence WHERE record_id = ?`,
      [recordId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      last_lat: row.last_lat != null ? Number(row.last_lat) : null,
      last_lng: row.last_lng != null ? Number(row.last_lng) : null,
      last_accuracy: row.last_accuracy != null ? Number(row.last_accuracy) : null,
    };
  },

  async create(conn, { recordId, userId, state, at, lat, lng, accuracy }) {
    const sql = `
      INSERT INTO attendance_presence
        (record_id, user_id, state, last_heartbeat_at, last_inside_at, outside_since,
         last_lat, last_lng, last_accuracy, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `;
    const params = [recordId, userId, state, at, state === 'INSIDE' ? at : null, lat, lng, accuracy, at];
    if (conn) await conn.query(sql, params);
    else await pool.query(sql, params);
  },

  async updateHeartbeat({ recordId, state, at, lat, lng, accuracy, lastInsideAt, outsideSince }) {
    const now = toUtcDateTime();
    await pool.query(
      `UPDATE attendance_presence
       SET state = ?, last_heartbeat_at = ?, last_inside_at = ?, outside_since = ?,
           last_lat = ?, last_lng = ?, last_accuracy = ?, updated_at = ?
       WHERE record_id = ?`,
      [state, at, lastInsideAt, outsideSince, lat, lng, accuracy, now, recordId]
    );
  },
};

module.exports = AttendancePresenceModel;
