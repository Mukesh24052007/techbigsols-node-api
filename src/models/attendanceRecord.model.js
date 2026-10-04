const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime, istCalendarDate } = require('../utils/time');

function parseRecord(row) {
  if (!row) return null;
  return {
    ...row,
    attendance_date: row.attendance_date instanceof Date ? istCalendarDate(row.attendance_date) : String(row.attendance_date),
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
  id, user_id, DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date, fullname, office_id,
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

  async updateRecordAdmin(id, { checkInAt, checkOutAt, status, workedMinutes }) {
    const setClauses = ['updated_at = UTC_TIMESTAMP()'];
    const params = [];

    if (checkInAt !== undefined) { setClauses.push('check_in_at = ?'); params.push(checkInAt); }
    if (checkOutAt !== undefined) { setClauses.push('check_out_at = ?'); params.push(checkOutAt); }
    if (status !== undefined) { setClauses.push('status = ?'); params.push(status); }
    if (workedMinutes !== undefined) { setClauses.push('worked_minutes = ?'); params.push(workedMinutes); }

    params.push(id);
    const [result] = await pool.query(
      `UPDATE attendance_records SET ${setClauses.join(', ')} WHERE id = ?`,
      params
    );
    return result.affectedRows > 0;
  },

  async upsertForRegularization({ userId, attendanceDate, fullname, officeId, checkInAt, checkOutAt, status, workedMinutes }) {
    const existing = await AttendanceRecordModel.findByUserDate(userId, attendanceDate);
    const now = toUtcDateTime();
    if (existing) {
      await pool.query(
        `UPDATE attendance_records
         SET check_in_at = ?, check_out_at = ?, status = ?, worked_minutes = ?, updated_at = ?
         WHERE id = ?`,
        [checkInAt, checkOutAt, status, workedMinutes, now, existing.id]
      );
      return { id: existing.id, action: 'updated', record: await AttendanceRecordModel.findById(existing.id) };
    } else {
      const [res] = await pool.query(
        `INSERT INTO attendance_records
          (user_id, attendance_date, fullname, office_id, check_in_at, check_out_at, status, worked_minutes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, attendanceDate, fullname, officeId, checkInAt, checkOutAt, status, workedMinutes, now, now]
      );
      return { id: res.insertId, action: 'created', record: await AttendanceRecordModel.findById(res.insertId) };
    }
  },
};

module.exports = AttendanceRecordModel;
