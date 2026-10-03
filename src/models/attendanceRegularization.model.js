const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime } = require('../utils/time');

const AttendanceRegularizationModel = {
  async create({ userId, attendanceDate, reason }) {
    const now = toUtcDateTime();
    const [result] = await pool.query(
      `INSERT INTO attendance_regularizations
        (user_id, attendance_date, reason, status, created_at)
       VALUES (?, ?, ?, 'PENDING', ?)`,
      [userId, attendanceDate, reason, now]
    );
    return result.insertId;
  },

  async findById(id) {
    const [rows] = await pool.query(
      `SELECT id, user_id, attendance_date, reason, status, reviewed_by,
              ${sqlUtc('reviewed_at')}, ${sqlUtc('created_at')}
       FROM attendance_regularizations WHERE id = ?`,
      [id]
    );
    return rows[0] || null;
  },
};

module.exports = AttendanceRegularizationModel;
