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
    'status', 'is_manual_override', 'override_reason', 'override_by', 'worked_minutes',
    'check_in_lat', 'check_in_lng', 'check_in_accuracy',
    'check_out_lat', 'check_out_lng', 'check_out_accuracy', 'ip', 'reason', 'created_at', 'updated_at',
  ],
  attendance_record: [
    'id', 'user_id', 'attendance_date', 'fullname', 'office_id', 'check_in_at', 'check_out_at',
    'status', 'is_manual_override', 'override_reason', 'override_by', 'worked_minutes',
    'check_in_lat', 'check_in_lng', 'check_in_accuracy',
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
    'id', 'user_id', 'attendance_date', 'name', 'status', 'reason', 'action',
    'is_manual_override', 'override_reason', 'override_by', 'created_at', 'updated_at',
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

  async log({ actorAdminId, action, entityType, entityId, beforeJson = null, afterJson = null }, conn = null) {
    const now = toUtcDateTime();
    const sanitizedBefore = sanitizeAuditData(beforeJson, entityType);
    const sanitizedAfter = sanitizeAuditData(afterJson, entityType);
    const executor = conn || pool;

    const [result] = await executor.query(
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

  async listLogs({ entityType = null, action = null, actorAdminId = null, page = 1, limit = 50 } = {}) {
    const whereClauses = [];
    const params = [];

    if (entityType) {
      whereClauses.push('l.entity_type = ?');
      params.push(entityType);
    }
    if (action) {
      whereClauses.push('l.action = ?');
      params.push(action);
    }
    if (actorAdminId) {
      whereClauses.push('l.actor_admin_id = ?');
      params.push(Number(actorAdminId));
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM attendance_audit_log l ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const validLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const validPage = Math.max(1, Number(page) || 1);
    const offset = (validPage - 1) * validLimit;

    const [rows] = await pool.query(
      `SELECT l.id, l.actor_admin_id, a.name AS actor_name, a.email AS actor_email,
              l.action, l.entity_type, l.entity_id,
              l.before_json, l.after_json,
              ${sqlUtc('l.created_at', 'created_at')}
       FROM attendance_audit_log l
       LEFT JOIN admins a ON l.actor_admin_id = a.id
       ${whereSql}
       ORDER BY l.id DESC
       LIMIT ? OFFSET ?`,
      [...params, validLimit, offset]
    );

    const logs = rows.map((r) => {
      let before = null;
      let after = null;
      try {
        before = typeof r.before_json === 'string' ? JSON.parse(r.before_json) : r.before_json;
      } catch (_) {}
      try {
        after = typeof r.after_json === 'string' ? JSON.parse(r.after_json) : r.after_json;
      } catch (_) {}

      return {
        id: r.id,
        actorAdminId: r.actor_admin_id,
        actorName: r.actor_name || null,
        actorEmail: r.actor_email || null,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        before,
        after,
        createdAt: r.created_at,
      };
    });

    return {
      total,
      page: validPage,
      limit: validLimit,
      totalPages: Math.ceil(total / validLimit) || 1,
      logs,
    };
  },
};

module.exports = AttendanceAuditLogModel;
