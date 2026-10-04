'use strict';

const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime } = require('../utils/time');

const AttendanceReverifyModel = {
  async pendingForRecord(recordId) {
    const [rows] = await pool.query(
      `SELECT id, record_id, user_id, status,
              ${sqlUtc('scheduled_at')}, ${sqlUtc('due_at')}, ${sqlUtc('completed_at')}
       FROM attendance_reverify_tasks
       WHERE record_id = ? AND status = 'PENDING'
       ORDER BY scheduled_at ASC, id ASC LIMIT 1`,
      [recordId]
    );
    return rows[0] || null;
  },

  async complete(id, completedAt = toUtcDateTime()) {
    const [result] = await pool.query(
      `UPDATE attendance_reverify_tasks
       SET status = 'COMPLETED', completed_at = ?
       WHERE id = ? AND status = 'PENDING'`,
      [completedAt, id]
    );
    return result.affectedRows > 0;
  },

  async markMissed(id) {
    const [result] = await pool.query(
      `UPDATE attendance_reverify_tasks
       SET status = 'MISSED'
       WHERE id = ? AND status = 'PENDING'`,
      [id]
    );
    return result.affectedRows > 0;
  },

  async schedule({ recordId, userId, scheduledAt, dueAt }) {
    const [result] = await pool.query(
      `INSERT INTO attendance_reverify_tasks
         (record_id, user_id, scheduled_at, due_at, status)
       VALUES (?, ?, ?, ?, 'PENDING')`,
      [recordId, userId, scheduledAt, dueAt]
    );
    return result.insertId;
  },

  async findByRecord(recordId) {
    const [rows] = await pool.query(
      `SELECT id, record_id, user_id, status,
              ${sqlUtc('scheduled_at')}, ${sqlUtc('due_at')}, ${sqlUtc('completed_at')}
       FROM attendance_reverify_tasks
       WHERE record_id = ?
       ORDER BY due_at ASC, id ASC`,
      [recordId]
    );
    return rows;
  },
};

module.exports = AttendanceReverifyModel;
