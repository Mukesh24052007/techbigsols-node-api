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

  async upsertProfile(userId, { officeId, shiftStart, shiftEnd, department, designation }) {
    const now = toUtcDateTime();
    await pool.query(
      `INSERT INTO attendance_profiles
        (user_id, office_id, shift_start, shift_end, department, designation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         office_id = COALESCE(VALUES(office_id), office_id),
         shift_start = COALESCE(VALUES(shift_start), shift_start),
         shift_end = COALESCE(VALUES(shift_end), shift_end),
         department = COALESCE(VALUES(department), department),
         designation = COALESCE(VALUES(designation), designation),
         updated_at = VALUES(updated_at)`,
      [userId, officeId || null, shiftStart || null, shiftEnd || null, department || null, designation || null, now, now]
    );
    return await AttendanceProfileModel.findByUserId(userId);
  },

  async listAllEmployees() {
    const [rows] = await pool.query(
      `SELECT
         u.user_id AS userId,
         u.fullname,
         u.email,
         p.department,
         p.designation,
         p.office_id,
         o.name AS office_name,
         CASE WHEN p.face_template IS NOT NULL AND LENGTH(p.face_template) > 0 THEN 1 ELSE 0 END AS faceEnrolled,
         CASE WHEN p.consent_at IS NOT NULL THEN 1 ELSE 0 END AS consentGiven,
         ${sqlUtc('p.consent_at', 'consentAt')},
         ${sqlUtc('p.face_enrolled_at', 'faceEnrolledAt')}
       FROM site_users u
       LEFT JOIN attendance_profiles p ON p.user_id = u.user_id COLLATE utf8mb4_unicode_ci
       LEFT JOIN attendance_offices o ON o.id = p.office_id
       WHERE u.is_active = 1
         AND JSON_CONTAINS(u.module_access, '"Attendance"')
       ORDER BY u.fullname ASC`
    );

    return rows.map((r) => ({
      userId: r.userId,
      fullname: r.fullname,
      email: r.email,
      department: r.department || null,
      designation: r.designation || null,
      office: r.office_id ? { id: r.office_id, name: r.office_name } : null,
      faceEnrolled: Boolean(r.faceEnrolled),
      consentGiven: Boolean(r.consentGiven),
      consentAt: r.consentAt || null,
      faceEnrolledAt: r.faceEnrolledAt || null,
    }));
  },
};

module.exports = AttendanceProfileModel;
