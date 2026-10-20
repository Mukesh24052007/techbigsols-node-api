const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime } = require('../utils/time');

const AttendanceChallengeModel = {
  async create({ id, userId, purpose, action, issuedAt, expiresAt, lat = null, lng = null }) {
    await pool.query(
      `INSERT INTO attendance_challenges
        (id, user_id, purpose, action, issued_at, expires_at, used_at, issued_lat, issued_lng)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [id, userId, purpose, action, issuedAt, expiresAt, lat, lng]
    );
  },

  async findById(id) {
    const [rows] = await pool.query(
      `SELECT id, user_id, purpose, action,
              ${sqlUtc('issued_at')}, ${sqlUtc('expires_at')}, ${sqlUtc('used_at')},
              issued_lat, issued_lng
       FROM attendance_challenges WHERE id = ?`,
      [id]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      ...r,
      issued_lat: r.issued_lat !== null && r.issued_lat !== undefined ? Number(r.issued_lat) : null,
      issued_lng: r.issued_lng !== null && r.issued_lng !== undefined ? Number(r.issued_lng) : null,
    };
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
