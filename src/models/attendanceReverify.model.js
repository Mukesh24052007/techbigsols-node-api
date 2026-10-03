const { pool } = require('../config/db');
const { sqlUtc } = require('../utils/time');

const AttendanceReverifyModel = {
  async pendingForRecord(recordId) {
    const [rows] = await pool.query(
      `SELECT id, record_id, user_id, status,
              ${sqlUtc('scheduled_at')}, ${sqlUtc('due_at')}, ${sqlUtc('completed_at')}
       FROM attendance_reverify_tasks
       WHERE record_id = ? AND status = 'PENDING'
       ORDER BY scheduled_at ASC LIMIT 1`,
      [recordId]
    );
    return rows[0] || null;
  },

  async complete(id, completedAt) {
    const [result] = await pool.query(
      `UPDATE attendance_reverify_tasks
       SET status = 'COMPLETED', completed_at = ?
       WHERE id = ? AND status = 'PENDING'`,
      [completedAt, id]
    );
    return result.affectedRows > 0;
  },
};

module.exports = AttendanceReverifyModel;
