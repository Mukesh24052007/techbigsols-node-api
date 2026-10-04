const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime, istCalendarDate } = require('../utils/time');

function parseRegularization(row) {
  if (!row) return null;
  return {
    ...row,
    attendance_date: row.attendance_date instanceof Date ? istCalendarDate(row.attendance_date) : String(row.attendance_date),
  };
}

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
      `SELECT r.id, r.user_id, DATE_FORMAT(r.attendance_date, '%Y-%m-%d') AS attendance_date,
              r.reason, r.status, r.reviewed_by,
              ${sqlUtc('r.reviewed_at')}, ${sqlUtc('r.created_at')},
              u.fullname, p.department
       FROM attendance_regularizations r
       LEFT JOIN site_users u ON u.user_id COLLATE utf8mb4_unicode_ci = r.user_id
       LEFT JOIN attendance_profiles p ON p.user_id = r.user_id
       WHERE r.id = ?`,
      [id]
    );
    return parseRegularization(rows[0]);
  },

  async findAll({ status, limit = 50, offset = 0 } = {}) {
    const whereClauses = [];
    const params = [];

    if (status) {
      whereClauses.push('r.status = ?');
      params.push(status);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const sql = `
      SELECT r.id, r.user_id, DATE_FORMAT(r.attendance_date, '%Y-%m-%d') AS attendance_date,
             r.reason, r.status, r.reviewed_by,
             ${sqlUtc('r.reviewed_at')}, ${sqlUtc('r.created_at')},
             u.fullname, p.department
      FROM attendance_regularizations r
      LEFT JOIN site_users u ON u.user_id COLLATE utf8mb4_unicode_ci = r.user_id
      LEFT JOIN attendance_profiles p ON p.user_id = r.user_id
      ${whereSql}
      ORDER BY r.id DESC
      LIMIT ? OFFSET ?
    `;
    params.push(Number(limit) || 50, Number(offset) || 0);

    const [rows] = await pool.query(sql, params);
    return rows.map(parseRegularization);
  },

  async updateStatus(id, { status, reviewedBy }) {
    const now = toUtcDateTime();
    const [result] = await pool.query(
      `UPDATE attendance_regularizations
       SET status = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ? AND status = 'PENDING'`,
      [status, reviewedBy, now, id]
    );
    return result.affectedRows > 0;
  },
};

module.exports = AttendanceRegularizationModel;
