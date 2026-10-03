const { pool } = require('../config/db');
const { toUtcDateTime } = require('../utils/time');

const AttendanceIntervalModel = {
  async open(conn, { recordId, state, startedAt }) {
    const sql = `
      INSERT INTO attendance_intervals (record_id, state, started_at, ended_at)
      VALUES (?, ?, ?, NULL)
    `;
    const params = [recordId, state, startedAt];
    if (conn) await conn.query(sql, params);
    else await pool.query(sql, params);
  },

  async closeOpen(recordId, endedAt, conn) {
    const sql = `
      UPDATE attendance_intervals
      SET ended_at = ?
      WHERE record_id = ? AND ended_at IS NULL
    `;
    const params = [endedAt, recordId];
    if (conn) await conn.query(sql, params);
    else await pool.query(sql, params);
  },

  async findOpen(recordId) {
    const [rows] = await pool.query(
      `SELECT id, record_id, state, DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s') AS started_at
       FROM attendance_intervals
       WHERE record_id = ? AND ended_at IS NULL
       ORDER BY id DESC LIMIT 1`,
      [recordId]
    );
    return rows[0] || null;
  },

  async sumInsideMinutes(recordId, untilUtc) {
    const [rows] = await pool.query(
      `SELECT COALESCE(SUM(
         TIMESTAMPDIFF(
           SECOND,
           started_at,
           COALESCE(ended_at, ?)
         )
       ), 0) AS seconds
       FROM attendance_intervals
       WHERE record_id = ? AND state = 'INSIDE'`,
      [untilUtc, recordId]
    );
    return Math.floor((Number(rows[0]?.seconds) || 0) / 60);
  },
};

module.exports = AttendanceIntervalModel;
