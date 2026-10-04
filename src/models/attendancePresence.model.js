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
    reason,
    outsideStreak,
    weakStreak,
    at,
    lat,
    lng,
    accuracy,
    lastInsideAt,
    outsideSince,
    leftAlertedAt,
  }) {
    const setClauses = ['updated_at = UTC_TIMESTAMP()'];
    const params = [];

    if (state !== undefined) {
      setClauses.push('state = ?');
      params.push(state);
    }
    if (reason !== undefined) {
      setClauses.push('reason = ?');
      params.push(reason);
    }
    if (outsideStreak !== undefined) {
      setClauses.push('outside_streak = ?');
      params.push(outsideStreak);
    }
    if (weakStreak !== undefined) {
      setClauses.push('weak_streak = ?');
      params.push(weakStreak);
    }
    if (at !== undefined) {
      setClauses.push('last_heartbeat_at = ?');
      params.push(at);
    }
    if (lastInsideAt !== undefined) {
      setClauses.push('last_inside_at = ?');
      params.push(lastInsideAt);
    }
    if (outsideSince !== undefined) {
      setClauses.push('outside_since = ?');
      params.push(outsideSince);
    }
    if (leftAlertedAt !== undefined) {
      setClauses.push('left_alerted_at = ?');
      params.push(leftAlertedAt);
    }
    if (lat !== undefined) {
      setClauses.push('last_lat = ?');
      params.push(lat);
    }
    if (lng !== undefined) {
      setClauses.push('last_lng = ?');
      params.push(lng);
    }
    if (accuracy !== undefined) {
      setClauses.push('last_accuracy = ?');
      params.push(accuracy);
    }

    let whereClause = 'WHERE record_id = ?';
    const whereParams = [recordId];

    if (expectedState !== undefined && expectedState !== null) {
      whereClause += ' AND state = ?';
      whereParams.push(expectedState);
    }
    if (expectedLastHeartbeat !== undefined) {
      if (expectedLastHeartbeat === null) {
        whereClause += ' AND last_heartbeat_at IS NULL';
      } else {
        whereClause += ' AND last_heartbeat_at = ?';
        whereParams.push(expectedLastHeartbeat);
      }
    }

    const sql = `
      UPDATE attendance_presence
      SET ${setClauses.join(', ')}
      ${whereClause}
    `;

    const [result] = await pool.query(sql, [...params, ...whereParams]);
    return result.affectedRows > 0;
  },

  async updateHeartbeat(opts) {
    return this.updateConditional(opts);
  },
};

module.exports = AttendancePresenceModel;
