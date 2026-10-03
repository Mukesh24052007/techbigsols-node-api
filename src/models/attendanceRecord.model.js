const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime } = require('../utils/time');

function parseRecord(row) {
  if (!row) return null;
  return {
    ...row,
    worked_minutes: Number(row.worked_minutes) || 0,
    check_in_lat: row.check_in_lat != null ? Number(row.check_in_lat) : null,
    check_in_lng: row.check_in_lng != null ? Number(row.check_in_lng) : null,
    check_in_accuracy: row.check_in_accuracy != null ? Number(row.check_in_accuracy) : null,
    check_out_lat: row.check_out_lat != null ? Number(row.check_out_lat) : null,
    check_out_lng: row.check_out_lng != null ? Number(row.check_out_lng) : null,
    check_out_accuracy: row.check_out_accuracy != null ? Number(row.check_out_accuracy) : null,
  };
}

const SELECT = `
  id, user_id, attendance_date, fullname, office_id,
  ${sqlUtc('check_in_at')}, ${sqlUtc('check_out_at')},
  status, worked_minutes,
  check_in_lat, check_in_lng, check_in_accuracy,
  check_out_lat, check_out_lng, check_out_accuracy, ip,
  ${sqlUtc('created_at')}, ${sqlUtc('updated_at')}
`;

const AttendanceRecordModel = {
  async findByUserDate(userId, attendanceDate) {
    const [rows] = await pool.query(
      `SELECT ${SELECT} FROM attendance_records WHERE user_id = ? AND attendance_date = ?`,
      [userId, attendanceDate]
    );
    return parseRecord(rows[0]);
  },

  async findOpenByUser(userId) {
    const [rows] = await pool.query(
      `SELECT ${SELECT}
       FROM attendance_records
       WHERE user_id = ? AND check_in_at IS NOT NULL AND check_out_at IS NULL
       ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    return parseRecord(rows[0]);
  },

  async findById(id) {
    const [rows] = await pool.query(
      `SELECT ${SELECT} FROM attendance_records WHERE id = ?`,
      [id]
    );
    return parseRecord(rows[0]);
  },

  async createCheckIn(conn, data) {
    const now = toUtcDateTime();
    const sql = `
      INSERT INTO attendance_records
        (user_id, attendance_date, fullname, office_id, check_in_at, check_out_at, status,
         worked_minutes, check_in_lat, check_in_lng, check_in_accuracy, ip, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      data.userId,
      data.attendanceDate,
      data.fullname,
      data.officeId,
      data.checkInAt,
      data.status,
      data.lat,
      data.lng,
      data.accuracy,
      data.ip,
      now,
      now,
    ];
    const [result] = conn
      ? await conn.query(sql, params)
      : await pool.query(sql, params);
    return result.insertId;
  },

  async checkout(id, { checkOutAt, workedMinutes, status, lat = null, lng = null, accuracy = null }) {
    const now = toUtcDateTime();
    await pool.query(
      `UPDATE attendance_records
       SET check_out_at = ?, worked_minutes = ?, status = ?,
           check_out_lat = ?, check_out_lng = ?, check_out_accuracy = ?, updated_at = ?
       WHERE id = ? AND check_out_at IS NULL`,
      [checkOutAt, workedMinutes, status, lat, lng, accuracy, now, id]
    );
  },

  async setWorkedMinutes(id, workedMinutes) {
    const now = toUtcDateTime();
    await pool.query(
      'UPDATE attendance_records SET worked_minutes = ?, updated_at = ? WHERE id = ?',
      [workedMinutes, now, id]
    );
  },

  async listByUserMonth(userId, year, month) {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
    const [rows] = await pool.query(
      `SELECT ${SELECT}
       FROM attendance_records
       WHERE user_id = ? AND attendance_date >= ? AND attendance_date < ?
       ORDER BY attendance_date ASC`,
      [userId, start, end]
    );
    return rows.map(parseRecord);
  },
};

module.exports = AttendanceRecordModel;
