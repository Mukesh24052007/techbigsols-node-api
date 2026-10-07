const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime } = require('../utils/time');

const AttendanceAttemptModel = {
  async create({ userId, kind, success, distanceScore = null, accuracy = null, ip = null, reason = null }) {
    const now = toUtcDateTime();
    await pool.query(
      `INSERT INTO attendance_attempts
        (user_id, kind, success, distance_score, accuracy, ip, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, kind, success ? 1 : 0, distanceScore, accuracy, ip, reason, now]
    );
  },

  async countRecentFailures(userId, sinceUtc) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n
       FROM attendance_attempts
       WHERE user_id = ?
         AND success = 0
         AND kind IN ('challenge', 'checkin', 'reverify')
         AND created_at >= ?`,
      [userId, sinceUtc]
    );
    return Number(rows[0]?.n) || 0;
  },

  async latestRateLimitViolation(userId) {
    const [rows] = await pool.query(
      `SELECT ${sqlUtc('created_at')}
       FROM attendance_attempts
       WHERE user_id = ? AND kind = 'violation' AND reason = 'rate_limit'
       ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  },

  async findAll({ userId, date, success, limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const safeOffset = Math.max(Number(offset) || 0, 0);

    const whereClauses = [];
    const params = [];

    if (userId) {
      whereClauses.push('a.user_id = ?');
      params.push(userId);
    }
    if (date) {
      whereClauses.push("DATE_FORMAT(a.created_at, '%Y-%m-%d') = ?");
      params.push(date);
    }
    if (success !== undefined && success !== null && success !== '') {
      whereClauses.push('a.success = ?');
      params.push(success === true || success === 'true' || success === '1' || success === 1 ? 1 : 0);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const sql = `
      SELECT a.id, a.user_id, a.kind, a.success, a.distance_score, a.accuracy, a.ip, a.reason,
             ${sqlUtc('a.created_at')},
             u.fullname, p.department
      FROM attendance_attempts a
      LEFT JOIN site_users u ON u.user_id = a.user_id
      LEFT JOIN attendance_profiles p ON p.user_id = a.user_id
      ${whereSql}
      ORDER BY a.id DESC
      LIMIT ? OFFSET ?
    `;
    params.push(safeLimit, safeOffset);

    const countSql = `SELECT COUNT(*) AS total FROM attendance_attempts a ${whereSql}`;
    const [countRows] = await pool.query(countSql, params.slice(0, -2));
    const [rows] = await pool.query(sql, params);

    return {
      total: Number(countRows[0]?.total) || 0,
      page: Math.floor(safeOffset / safeLimit) + 1,
      limit: safeLimit,
      rows: rows.map((r) => ({
        ...r,
        success: Boolean(r.success),
        distance_score: r.distance_score != null ? Number(r.distance_score) : null,
        accuracy: r.accuracy != null ? Number(r.accuracy) : null,
      })),
    };
  },
};

module.exports = AttendanceAttemptModel;
