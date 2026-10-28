const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime, istCalendarDate } = require('../utils/time');

function parseSession(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    office_id: Number(row.office_id),
    attendance_date: row.attendance_date instanceof Date
      ? istCalendarDate(row.attendance_date)
      : String(row.attendance_date).slice(0, 10),
    generation_seq: Number(row.generation_seq),
    created_by_admin_id: Number(row.created_by_admin_id),
    revoked_by_admin_id: row.revoked_by_admin_id != null ? Number(row.revoked_by_admin_id) : null,
  };
}

const SELECT = `
  id, session_token_hash, encrypted_token, office_id,
  DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
  action, generation_seq, status, created_by_admin_id,
  ${sqlUtc('expires_at')}, ${sqlUtc('revoked_at')},
  revoked_by_admin_id, revocation_reason, active_slot,
  ${sqlUtc('created_at')}, ${sqlUtc('updated_at')}
`;

const AttendanceQrSessionModel = {
  parseSession,

  async create(conn, data) {
    const now = toUtcDateTime();
    const executor = conn || pool;
    const sql = `
      INSERT INTO attendance_qr_sessions
        (session_token_hash, encrypted_token, office_id, attendance_date, action, generation_seq,
         status, created_by_admin_id, expires_at, active_slot, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)
    `;
    const params = [
      data.sessionTokenHash,
      data.encryptedToken || null,
      data.officeId,
      data.attendanceDate,
      data.action,
      data.generationSeq || 1,
      data.createdByAdminId,
      data.expiresAt,
      data.activeSlot,
      now,
      now,
    ];
    const [result] = await executor.query(sql, params);
    return result.insertId;
  },

  async findById(id) {
    const [rows] = await pool.query(`SELECT ${SELECT} FROM attendance_qr_sessions WHERE id = ?`, [id]);
    return parseSession(rows[0]);
  },

  async findByHash(tokenHash) {
    const [rows] = await pool.query(
      `SELECT ${SELECT} FROM attendance_qr_sessions WHERE session_token_hash = ?`,
      [tokenHash]
    );
    return parseSession(rows[0]);
  },

  async findActiveBySlot(activeSlot) {
    const [rows] = await pool.query(
      `SELECT ${SELECT} FROM attendance_qr_sessions WHERE active_slot = ? AND status = 'ACTIVE'`,
      [activeSlot]
    );
    return parseSession(rows[0]);
  },

  async findActive({ officeId, attendanceDate, action }) {
    const [rows] = await pool.query(
      `SELECT ${SELECT}
       FROM attendance_qr_sessions
       WHERE office_id = ? AND attendance_date = ? AND action = ? AND status = 'ACTIVE'
       ORDER BY id DESC LIMIT 1`,
      [officeId, attendanceDate, action]
    );
    return parseSession(rows[0]);
  },

  async findLatestSession({ officeId, attendanceDate, action }) {
    const [rows] = await pool.query(
      `SELECT ${SELECT}
       FROM attendance_qr_sessions
       WHERE office_id = ? AND attendance_date = ? AND action = ?
       ORDER BY id DESC LIMIT 1`,
      [officeId, attendanceDate, action]
    );
    return parseSession(rows[0]);
  },

  async findAllToday({ officeId, attendanceDate, action }) {
    const [rows] = await pool.query(
      `SELECT ${SELECT}
       FROM attendance_qr_sessions
       WHERE office_id = ? AND attendance_date = ? AND action = ?
       ORDER BY id ASC`,
      [officeId, attendanceDate, action]
    );
    return rows.map(parseSession);
  },

  async revoke(conn, { id, adminId, reason }) {
    const now = toUtcDateTime();
    const executor = conn || pool;
    const [result] = await executor.query(
      `UPDATE attendance_qr_sessions
       SET status = 'REVOKED',
           revoked_at = ?,
           revoked_by_admin_id = ?,
           revocation_reason = ?,
           active_slot = NULL,
           encrypted_token = NULL,
           updated_at = ?
       WHERE id = ?`,
      [now, adminId, reason, now, id]
    );
    return result.affectedRows > 0;
  },

  async expire(conn, id) {
    const now = toUtcDateTime();
    const executor = conn || pool;
    const [result] = await executor.query(
      `UPDATE attendance_qr_sessions
       SET status = 'EXPIRED',
           active_slot = NULL,
           updated_at = ?
       WHERE id = ? AND status = 'ACTIVE'`,
      [now, id]
    );
    return result.affectedRows > 0;
  },
};

module.exports = AttendanceQrSessionModel;
