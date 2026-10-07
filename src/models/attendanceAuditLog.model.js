const { pool } = require('../config/db');
const { toUtcDateTime, sqlUtc } = require('../utils/time');

const WHITELISTS = {
  office: [
    'id', 'name', 'lat', 'lng', 'radius_m', 'accuracy_max_m', 'ip_allowlist', 'require_both',
    'shift_start', 'shift_end', 'grace_minutes', 'outside_tolerance_minutes',
    'short_outing_allowance_minutes', 'heartbeat_seconds', 'reverify_count',
    'created_at', 'updated_at',
  ],
  profile: [
    'user_id', 'department', 'designation', 'office_id', 'shift_start', 'shift_end',
    'consent_at', 'consent_version', 'face_enrolled_at', 'created_at', 'updated_at',
  ],
  record: [
    'id', 'user_id', 'attendance_date', 'fullname', 'office_id', 'check_in_at', 'check_out_at',
    'status', 'worked_minutes', 'check_in_lat', 'check_in_lng', 'check_in_accuracy',
    'check_out_lat', 'check_out_lng', 'check_out_accuracy', 'ip', 'reason', 'created_at', 'updated_at',
  ],
  regularization: [
    'id', 'user_id', 'attendance_date', 'reason', 'status', 'reviewed_by', 'reviewed_at',
    'check_in_time', 'check_out_time', 'created_at',
  ],
  leave: [
    'id', 'user_id', 'leave_date', 'from_date', 'to_date', 'reason', 'status',
    'reviewed_by', 'reviewed_at', 'created_at',
  ],
};

function sanitizeAuditData(data, entityType) {
  if (!data || typeof data !== 'object') return null;
  const allowed = WHITELISTS[entityType] || [
    'id', 'user_id', 'name', 'status', 'reason', 'action', 'created_at', 'updated_at',
  ];
  const cleaned = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      cleaned[key] = data[key];
    }
  }
  return cleaned;
}

const AttendanceAuditLogModel = {
  sanitizeAuditData,

  async log({ actorAdminId, action, entityType, entityId, beforeJson = null, afterJson = null }) {
    const now = toUtcDateTime();
    const sanitizedBefore = sanitizeAuditData(beforeJson, entityType);
    const sanitizedAfter = sanitizeAuditData(afterJson, entityType);

    const [result] = await pool.query(
      `INSERT INTO attendance_audit_log
        (actor_admin_id, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        actorAdminId,
        action,
        entityType,
        String(entityId),
        sanitizedBefore ? JSON.stringify(sanitizedBefore) : null,
        sanitizedAfter ? JSON.stringify(sanitizedAfter) : null,
        now,
      ]
    );
    return result.insertId;
  },

  async listRecent(limit = 50) {
    const [rows] = await pool.query(
      `SELECT id, actor_admin_id, action, entity_type, entity_id,
              before_json, after_json, ${sqlUtc('created_at')}
       FROM attendance_audit_log
       ORDER BY id DESC
       LIMIT ?`,
      [Number(limit) || 50]
    );
    return rows;
  },
};

module.exports = AttendanceAuditLogModel;
