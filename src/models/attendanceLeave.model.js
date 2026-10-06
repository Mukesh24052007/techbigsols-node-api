const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime, istCalendarDate } = require('../utils/time');

function parseLeave(row) {
  if (!row) return null;
  return {
    ...row,
    leave_date: row.leave_date instanceof Date ? istCalendarDate(row.leave_date) : String(row.leave_date),
  };
}

const SELECT = `
  l.id, l.user_id, DATE_FORMAT(l.leave_date, '%Y-%m-%d') AS leave_date,
  l.reason, l.status, l.reviewed_by,
  ${sqlUtc('l.reviewed_at')}, ${sqlUtc('l.created_at')}
`;

const AttendanceLeaveModel = {
  async findById(id) {
    const [rows] = await pool.query(
      `SELECT ${SELECT}, u.fullname, p.department
       FROM attendance_leaves l
       LEFT JOIN site_users u ON u.user_id = l.user_id
       LEFT JOIN attendance_profiles p ON p.user_id = l.user_id
       WHERE l.id = ?`,
      [id]
    );
    return parseLeave(rows[0]);
  },

  async findOverlapping(userId, fromDate, toDate) {
    const [rows] = await pool.query(
      `SELECT id, user_id, DATE_FORMAT(leave_date, '%Y-%m-%d') AS leave_date, status
       FROM attendance_leaves
       WHERE user_id = ? AND leave_date BETWEEN ? AND ? AND status != 'REJECTED'`,
      [userId, fromDate, toDate]
    );
    return rows.map(parseLeave);
  },

  async createApprovedSpan({ userId, fromDate, toDate, reason, reviewedBy }) {
    const start = new Date(`${fromDate}T00:00:00Z`);
    const end = new Date(`${toDate}T00:00:00Z`);
    const dates = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }

    const now = toUtcDateTime();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const createdIds = [];
      for (const ymd of dates) {
        const [res] = await conn.query(
          `INSERT INTO attendance_leaves
            (user_id, leave_date, reason, status, reviewed_by, reviewed_at, created_at)
           VALUES (?, ?, ?, 'APPROVED', ?, ?, ?)`,
          [userId, ymd, reason, reviewedBy, now, now]
        );
        createdIds.push(res.insertId);
      }
      await conn.commit();
      return { count: dates.length, dates, ids: createdIds };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  async findAll({ userId, month, status, limit = 100, offset = 0 } = {}) {
    const whereClauses = [];
    const params = [];

    if (userId) {
      whereClauses.push('l.user_id = ?');
      params.push(userId);
    }
    if (month) {
      whereClauses.push("DATE_FORMAT(l.leave_date, '%Y-%m') = ?");
      params.push(month);
    }
    if (status) {
      whereClauses.push('l.status = ?');
      params.push(status);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const sql = `
      SELECT ${SELECT}, u.fullname, p.department
      FROM attendance_leaves l
      LEFT JOIN site_users u ON u.user_id = l.user_id
      LEFT JOIN attendance_profiles p ON p.user_id = l.user_id
      ${whereSql}
      ORDER BY l.leave_date DESC, l.id DESC
      LIMIT ? OFFSET ?
    `;
    params.push(Number(limit) || 100, Number(offset) || 0);

    const [rows] = await pool.query(sql, params);
    return rows.map(parseLeave);
  },

  async cancelLeave(id, adminId) {
    const now = toUtcDateTime();
    const [result] = await pool.query(
      `UPDATE attendance_leaves
       SET status = 'REJECTED', reviewed_by = ?, reviewed_at = ?
       WHERE id = ? AND status != 'REJECTED'`,
      [adminId, now, id]
    );
    return result.affectedRows > 0;
  },

  async delete(id) {
    const [result] = await pool.query('DELETE FROM attendance_leaves WHERE id = ?', [id]);
    return result.affectedRows > 0;
  },
};

module.exports = AttendanceLeaveModel;
