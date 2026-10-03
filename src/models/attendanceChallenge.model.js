const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime } = require('../utils/time');

const AttendanceChallengeModel = {
  async create({ id, userId, purpose, action, issuedAt, expiresAt }) {
    await pool.query(
      `INSERT INTO attendance_challenges
        (id, user_id, purpose, action, issued_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [id, userId, purpose, action, issuedAt, expiresAt]
    );
  },

  async findById(id) {
    const [rows] = await pool.query(
      `SELECT id, user_id, purpose, action,
              ${sqlUtc('issued_at')}, ${sqlUtc('expires_at')}, ${sqlUtc('used_at')}
       FROM attendance_challenges WHERE id = ?`,
      [id]
    );
    return rows[0] || null;
  },

  async markUsed(id, usedAt) {
    const [result] = await pool.query(
      `UPDATE attendance_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL`,
      [usedAt, id]
    );
    return result.affectedRows > 0;
  },
};

module.exports = AttendanceChallengeModel;
