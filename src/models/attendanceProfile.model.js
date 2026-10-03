const { pool } = require('../config/db');
const { sqlUtc, toUtcDateTime } = require('../utils/time');

function parseProfile(row) {
  if (!row) return null;
  const { face_template, ...rest } = row;
  return {
    ...rest,
    faceEnrolled: Boolean(face_template && face_template.length),
    _hasTemplate: Boolean(face_template && face_template.length),
  };
}

const AttendanceProfileModel = {
  async findByUserId(userId) {
    const [rows] = await pool.query(
      `SELECT user_id, department, designation, office_id,
              TIME_FORMAT(shift_start, '%H:%i:%s') AS shift_start,
              TIME_FORMAT(shift_end, '%H:%i:%s') AS shift_end,
              face_template,
              ${sqlUtc('face_enrolled_at')}, ${sqlUtc('consent_at')},
              consent_version, ${sqlUtc('created_at')}, ${sqlUtc('updated_at')}
       FROM attendance_profiles WHERE user_id = ?`,
      [userId]
    );
    return rows[0] ? parseProfile(rows[0]) : null;
  },

  async getTemplate(userId) {
    const [rows] = await pool.query(
      'SELECT face_template FROM attendance_profiles WHERE user_id = ?',
      [userId]
    );
    return rows[0]?.face_template || null;
  },

  async upsertConsent(userId, version) {
    const now = toUtcDateTime();
    await pool.query(
      `INSERT INTO attendance_profiles (user_id, consent_at, consent_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE consent_at = VALUES(consent_at),
                               consent_version = VALUES(consent_version),
                               updated_at = VALUES(updated_at)`,
      [userId, now, version, now, now]
    );
  },

  async upsertFace(userId, templateBuffer) {
    const now = toUtcDateTime();
    await pool.query(
      `INSERT INTO attendance_profiles (user_id, face_template, face_enrolled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE face_template = VALUES(face_template),
                               face_enrolled_at = VALUES(face_enrolled_at),
                               updated_at = VALUES(updated_at)`,
      [userId, templateBuffer, now, now, now]
    );
  },

  async clearFace(userId) {
    const now = toUtcDateTime();
    const [result] = await pool.query(
      `UPDATE attendance_profiles
       SET face_template = NULL, face_enrolled_at = NULL, updated_at = ?
       WHERE user_id = ?`,
      [now, userId]
    );
    return result.affectedRows > 0;
  },
};

module.exports = AttendanceProfileModel;
