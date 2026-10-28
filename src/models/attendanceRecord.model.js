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
    is_manual_override: Boolean(row.is_manual_override),
    override_reason: row.override_reason || null,
    override_by: row.override_by != null ? Number(row.override_by) : null,
  };
}

const SELECT = `
  id, user_id, DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date, fullname, office_id,
  ${sqlUtc('check_in_at')}, ${sqlUtc('check_out_at')},
  status, is_manual_override, override_reason, override_by, worked_minutes,
  check_in_lat, check_in_lng, check_in_accuracy,
  check_out_lat, check_out_lng, check_out_accuracy, ip,
  ${sqlUtc('created_at')}, ${sqlUtc('updated_at')}
`;

const AttendanceRecordModel = {
  parseRecord,

  async findByUserDate(userId, attendanceDate) {
    const [rows] = await pool.query(
      `SELECT ${SELECT} FROM attendance_records WHERE user_id = ? AND attendance_date = ?`,
      [userId, attendanceDate]
    );
    return parseRecord(rows[0]);
  },

  async findByUserDateForUpdate(conn, userId, attendanceDate) {
    const [rows] = await conn.query(
      `SELECT ${SELECT} FROM attendance_records WHERE user_id = ? AND attendance_date = ? FOR UPDATE`,
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

  async listUserHistory({ userId, startDate = null, endDate = null, limit = 30, offset = 0 }) {
    let sql = `SELECT ${SELECT} FROM attendance_records WHERE user_id = ?`;
    const params = [userId];

    if (startDate) {
      sql += ' AND attendance_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND attendance_date <= ?';
      params.push(endDate);
    }

    sql += ' ORDER BY attendance_date DESC, id DESC LIMIT ? OFFSET ?';
    const validLimit = Math.min(100, Math.max(1, Number(limit) || 30));
    const validOffset = Math.max(0, Number(offset) || 0);
    params.push(validLimit, validOffset);

    const [rows] = await pool.query(sql, params);
    return rows.map(parseRecord);
  },

  async listDailyLogs({ date, status = null, officeId = null, page = 1, limit = 50 }) {
    const whereClauses = ['attendance_date = ?'];
    const params = [date];

    if (status) {
      whereClauses.push('status = ?');
      params.push(status);
    }
    if (officeId != null && officeId !== '') {
      whereClauses.push('office_id = ?');
      params.push(Number(officeId));
    }

    const whereSql = whereClauses.join(' AND ');

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM attendance_records WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const validLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const validPage = Math.max(1, Number(page) || 1);
    const offset = (validPage - 1) * validLimit;

    const [rows] = await pool.query(
      `SELECT ${SELECT} FROM attendance_records WHERE ${whereSql} ORDER BY id ASC LIMIT ? OFFSET ?`,
      [...params, validLimit, offset]
    );

    return {
      total,
      page: validPage,
      limit: validLimit,
      totalPages: Math.ceil(total / validLimit) || 1,
      records: rows.map(parseRecord),
    };
  },

  /**
   * Apply an administrative manual override within a database transaction.
   * Preserves any existing check-in/check-out timestamps and worked minutes.
   * Sets is_manual_override = 1, override_reason, and override_by.
   *
   * @param {object} conn - Active MySQL connection with transaction
   * @param {object} params
   * @returns {Promise<{ recordId: number, beforeState: object|null, afterState: object }>}
   */
  async applyManualOverride(conn, { userId, attendanceDate, fullname, status, reason, adminId }) {
    const now = toUtcDateTime();

    // 1. Lock existing record if present
    const [existingRows] = await conn.query(
      `SELECT ${SELECT}
       FROM attendance_records
       WHERE user_id = ? AND attendance_date = ?
       FOR UPDATE`,
      [userId, attendanceDate]
    );

    let recordId;
    let beforeState = null;

    if (existingRows.length > 0) {
      beforeState = parseRecord(existingRows[0]);
      recordId = existingRows[0].id;

      // Update status and override metadata, preserving existing check-in/out timestamps and worked minutes
      await conn.query(
        `UPDATE attendance_records
         SET status = ?,
             is_manual_override = 1,
             override_reason = ?,
             override_by = ?,
             updated_at = ?
         WHERE id = ?`,
        [status, reason, adminId, now, recordId]
      );
    } else {
      // Record does not exist yet. Insert new record with status and override metadata.
      try {
        const [res] = await conn.query(
          `INSERT INTO attendance_records
            (user_id, attendance_date, fullname, office_id, check_in_at, check_out_at,
             status, is_manual_override, override_reason, override_by, worked_minutes,
             created_at, updated_at)
           VALUES (?, ?, ?, 1, NULL, NULL, ?, 1, ?, ?, 0, ?, ?)`,
          [userId, attendanceDate, fullname, status, reason, adminId, now, now]
        );
        recordId = res.insertId;
      } catch (insertErr) {
        if (insertErr.code === 'ER_DUP_ENTRY') {
          // Handled concurrent insert: lock and update
          const [retryRows] = await conn.query(
            `SELECT ${SELECT}
             FROM attendance_records
             WHERE user_id = ? AND attendance_date = ?
             FOR UPDATE`,
            [userId, attendanceDate]
          );
          if (retryRows.length > 0) {
            beforeState = parseRecord(retryRows[0]);
            recordId = retryRows[0].id;
            await conn.query(
              `UPDATE attendance_records
               SET status = ?,
                   is_manual_override = 1,
                   override_reason = ?,
                   override_by = ?,
                   updated_at = ?
               WHERE id = ?`,
              [status, reason, adminId, now, recordId]
            );
          } else {
            throw insertErr;
          }
        } else {
          throw insertErr;
        }
      }
    }

    // 2. Fetch refreshed afterState
    const [afterRows] = await conn.query(
      `SELECT ${SELECT} FROM attendance_records WHERE id = ?`,
      [recordId]
    );
    const afterState = parseRecord(afterRows[0]);

    return { recordId, beforeState, afterState };
  },
};

module.exports = AttendanceRecordModel;
