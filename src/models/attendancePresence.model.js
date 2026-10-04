const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime } = require('../utils/time');

const AttendancePresenceModel = {
  async findByRecordId(recordId) {
    const [rows] = await pool.query(
      `SELECT record_id, user_id, state, reason, outside_streak, weak_streak,
              ${sqlUtc('last_heartbeat_at')}, ${sqlUtc('last_inside_at')}, ${sqlUtc('outside_since')},
              last_lat, last_lng, last_accuracy, ${sqlUtc('left_alerted_at')}, ${sqlUtc('updated_at')}
       FROM attendance_presence WHERE record_id = ?`,
      [recordId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      outside_streak: Number(row.outside_streak) || 0,
      weak_streak: Number(row.weak_streak) || 0,
      last_lat: row.last_lat != null ? Number(row.last_lat) : null,
      last_lng: row.last_lng != null ? Number(row.last_lng) : null,
      last_accuracy: row.last_accuracy != null ? Number(row.last_accuracy) : null,
    };
  },

  async create(conn, { recordId, userId, state, reason = null, outsideStreak = 0, weakStreak = 0, at, lat, lng, accuracy }) {
    const sql = `
      INSERT INTO attendance_presence
        (record_id, user_id, state, reason, outside_streak, weak_streak, last_heartbeat_at, last_inside_at, outside_since,
         last_lat, last_lng, last_accuracy, left_alerted_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?)
    `;
    const params = [recordId, userId, state, reason, outsideStreak, weakStreak, at, state === 'INSIDE' ? at : null, lat, lng, accuracy, at];
    if (conn) await conn.query(sql, params);
    else await pool.query(sql, params);
  },

  async updateConditional({
    recordId,
    expectedState,
    expectedLastHeartbeat,
    state,
    reason = null,
    outsideStreak = 0,
    weakStreak = 0,
    at,
    lat = null,
    lng = null,
    accuracy = null,
    lastInsideAt,
    outsideSince,
    leftAlertedAt,
  }) {
    const now = toUtcDateTime();
    let whereClause = 'WHERE record_id = ?';
    const params = [
      state,
      reason,
      outsideStreak,
      weakStreak,
      at !== undefined ? at : null,
      lastInsideAt !== undefined ? lastInsideAt : null,
      outsideSince !== undefined ? outsideSince : null,
      lat !== undefined ? lat : null,
      lng !== undefined ? lng : null,
      accuracy !== undefined ? accuracy : null,
      leftAlertedAt !== undefined ? leftAlertedAt : null,
      now,
      recordId,
    ];

    if (expectedState !== undefined && expectedState !== null) {
      whereClause += ' AND state = ?';
      params.push(expectedState);
    }
    if (expectedLastHeartbeat !== undefined) {
      if (expectedLastHeartbeat === null) {
        whereClause += ' AND last_heartbeat_at IS NULL';
      } else {
        whereClause += ' AND last_heartbeat_at = ?';
        params.push(expectedLastHeartbeat);
      }
    }

    const sql = `
      UPDATE attendance_presence
      SET state = ?,
          reason = ?,
          outside_streak = ?,
          weak_streak = ?,
          last_heartbeat_at = CASE WHEN ? IS NOT NULL THEN ? ELSE last_heartbeat_at END,
          last_inside_at = ?,
          outside_since = ?,
          last_lat = CASE WHEN ? IS NOT NULL THEN ? ELSE last_lat END,
          last_lng = CASE WHEN ? IS NOT NULL THEN ? ELSE last_lng END,
          last_accuracy = CASE WHEN ? IS NOT NULL THEN ? ELSE last_accuracy END,
          left_alerted_at = ?,
          updated_at = ?
      ${whereClause}
    `;

    // Duplicate positional params for CASE WHEN conditions
    const finalParams = [
      params[0], // state
      params[1], // reason
      params[2], // outsideStreak
      params[3], // weakStreak
      params[4], params[4], // at
      params[5], // lastInsideAt
      params[6], // outsideSince
      params[7], params[7], // lat
      params[8], params[8], // lng
      params[9], params[9], // accuracy
      params[10], // leftAlertedAt
      params[11], // updated_at
      ...params.slice(12), // where params
    ];

    const [result] = await pool.query(sql, finalParams);
    return result.affectedRows > 0;
  },

  async updateHeartbeat(opts) {
    return this.updateConditional(opts);
  },
};

module.exports = AttendancePresenceModel;
