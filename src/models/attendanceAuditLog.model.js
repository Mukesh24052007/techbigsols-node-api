const { pool } = require('../config/db');
const { toUtcDateTime, sqlUtc } = require('../utils/time');

const AttendanceAuditLogModel = {
  async log({ actorAdminId, action, entityType, entityId, beforeJson = null, afterJson = null }) {
    const now = toUtcDateTime();
    const [result] = await pool.query(
      `INSERT INTO attendance_audit_log
        (actor_admin_id, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        actorAdminId,
        action,
        entityType,
        String(entityId),
        beforeJson ? JSON.stringify(beforeJson) : null,
        afterJson ? JSON.stringify(afterJson) : null,
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
