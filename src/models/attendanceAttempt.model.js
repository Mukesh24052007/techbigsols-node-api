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
};

module.exports = AttendanceAttemptModel;
