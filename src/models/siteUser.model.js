const { pool } = require('../config/db');
const { toUtcDateTime } = require('../utils/time');

/**
 * Valid module access options — kept here as the single source of truth.
 */
const MODULES = [
  'Attendance',
  'Asset master',
  'Product master',
  'Employee master',
  'Payroll sheet',
  'Accounts module',
  'Inventory report',
  'Profit and loss',
  'Balance sheet',
  'Trial balance',
];

/**
 * Concurrency-safe sequential employee ID allocator using app_sequences table.
 * Allocates IDs in the format: TBS001, TBS002, TBS003, …
 * Uses SELECT … FOR UPDATE on the 'employee_id' sequence row to serialize allocation.
 * Reconciles against any existing TBS IDs in site_users to prevent gaps or collisions.
 * Preserves all legacy tbusr… IDs without rewriting them.
 *
 * @param {object} conn - An active database connection
 * @returns {Promise<string>}
 */
async function generateUserId(conn) {
  const needsOwnConn = !conn;
  const connection = needsOwnConn ? await pool.getConnection() : conn;
  const now = toUtcDateTime();

  try {
    if (needsOwnConn) {
      await connection.beginTransaction();
    }

    // 1. Ensure sequence row exists in app_sequences
    await connection.query(
      `INSERT INTO app_sequences (sequence_name, current_val, updated_at)
       VALUES ('employee_id', 0, ?)
       ON DUPLICATE KEY UPDATE sequence_name = sequence_name`,
      [now]
    );

    // 2. Acquire exclusive row lock on 'employee_id'
    const [seqRows] = await connection.query(
      `SELECT current_val FROM app_sequences WHERE sequence_name = 'employee_id' FOR UPDATE`
    );

    let currentVal = Number(seqRows[0]?.current_val || 0);

    // 3. Reconcile with any existing TBS IDs in site_users
    const [tbsRows] = await connection.query(
      `SELECT MAX(CAST(SUBSTRING(user_id, 4) AS UNSIGNED)) AS max_val
       FROM site_users
       WHERE user_id REGEXP '^TBS[0-9]+'`
    );
    const maxExisting = Number(tbsRows[0]?.max_val || 0);
    if (maxExisting > currentVal) {
      currentVal = maxExisting;
    }

    // 4. Increment sequence
    const nextVal = currentVal + 1;
    await connection.query(
      `UPDATE app_sequences SET current_val = ?, updated_at = ? WHERE sequence_name = 'employee_id'`,
      [nextVal, now]
    );

    if (needsOwnConn) {
      await connection.commit();
    }

    const padded = String(nextVal).padStart(3, '0');
    return `TBS${padded}`;
  } catch (err) {
    if (needsOwnConn) {
      await connection.rollback();
    }
    throw err;
  } finally {
    if (needsOwnConn) {
      connection.release();
    }
  }
}

const SiteUserModel = {
  MODULES,
  generateUserId,

  /**
   * Return all site-users (password excluded).
   */
  async findAll() {
    const [rows] = await pool.query(
      `SELECT user_id, fullname, email, module_access, is_active,
              must_change_password, role, phone, department, designation,
              created_at, updated_at
       FROM site_users
       ORDER BY user_id ASC`
    );
    return rows.map(SiteUserModel._parse);
  },

  /**
   * Find a single site-user by user_id (password excluded).
   */
  async findById(userId) {
    const [rows] = await pool.query(
      `SELECT user_id, fullname, email, module_access, is_active,
              must_change_password, role, phone, department, designation,
              created_at, updated_at
       FROM site_users WHERE user_id = ?`,
      [userId]
    );
    return rows[0] ? SiteUserModel._parse(rows[0]) : null;
  },

  /**
   * Find a site-user by email — includes password (used for auth only).
   * Performs case-insensitive matching.
   */
  async findByEmail(email) {
    if (!email || typeof email !== 'string') return null;
    const [rows] = await pool.query(
      `SELECT user_id, fullname, email, password, module_access, is_active,
              must_change_password, role, phone, department, designation,
              created_at, updated_at
       FROM site_users WHERE LOWER(email) = LOWER(?)`,
      [email.trim()]
    );
    return rows[0] ? SiteUserModel._parse(rows[0]) : null;
  },

  /**
   * Create a new site-user with sequential TBS ID.
   * Runs inside a transaction to guarantee atomic, collision-free id generation.
   *
   * @param {object} data
   * @returns {Promise<object>}
   */
  async create({
    fullname,
    email,
    password,
    moduleAccess = [],
    role = 'employee',
    phone = null,
    department = null,
    designation = null,
    mustChangePassword = 1,
  }) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const userId = await generateUserId(conn);
      const normalizedEmail = email.toLowerCase().trim();

      await conn.query(
        `INSERT INTO site_users
           (user_id, fullname, email, password, module_access, is_active,
            must_change_password, role, phone, department, designation)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        [
          userId,
          fullname.trim(),
          normalizedEmail,
          password,
          JSON.stringify(moduleAccess),
          mustChangePassword ? 1 : 0,
          role || 'employee',
          phone || null,
          department || null,
          designation || null,
        ]
      );

      await conn.commit();
      return {
        userId,
        fullname: fullname.trim(),
        email: normalizedEmail,
        role: role || 'employee',
        phone: phone || null,
        department: department || null,
        designation: designation || null,
        moduleAccess,
        mustChangePassword: Boolean(mustChangePassword),
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  /**
   * Update an existing site-user.
   * Only supplied fields are changed; password update is optional.
   */
  async update(userId, {
    fullname,
    email,
    password,
    moduleAccess,
    is_active,
    must_change_password,
    role,
    phone,
    department,
    designation,
  }) {
    const fields = [];
    const values = [];

    if (fullname !== undefined) {
      fields.push('fullname = ?');
      values.push(fullname.trim());
    }
    if (email !== undefined) {
      fields.push('email = ?');
      values.push(email.toLowerCase().trim());
    }
    if (password !== undefined) {
      fields.push('password = ?');
      values.push(password);
    }
    if (moduleAccess !== undefined) {
      fields.push('module_access = ?');
      values.push(JSON.stringify(moduleAccess));
    }
    if (is_active !== undefined) {
      fields.push('is_active = ?');
      values.push(is_active ? 1 : 0);
    }
    if (must_change_password !== undefined) {
      fields.push('must_change_password = ?');
      values.push(must_change_password ? 1 : 0);
    }
    if (role !== undefined) {
      fields.push('role = ?');
      values.push(role);
    }
    if (phone !== undefined) {
      fields.push('phone = ?');
      values.push(phone);
    }
    if (department !== undefined) {
      fields.push('department = ?');
      values.push(department);
    }
    if (designation !== undefined) {
      fields.push('designation = ?');
      values.push(designation);
    }

    if (fields.length === 0) return false;

    values.push(userId);
    const [result] = await pool.query(
      `UPDATE site_users SET ${fields.join(', ')} WHERE user_id = ?`,
      values
    );
    return result.affectedRows > 0;
  },

  /**
   * Delete a site-user by user_id.
   */
  async remove(userId) {
    const [result] = await pool.query(
      'DELETE FROM site_users WHERE user_id = ?',
      [userId]
    );
    return result.affectedRows > 0;
  },

  /**
   * Parse the JSON module_access column and normalise fields.
   * @private
   */
  _parse(row) {
    if (!row) return null;
    let moduleAccess = [];
    try {
      moduleAccess = typeof row.module_access === 'string'
        ? JSON.parse(row.module_access)
        : row.module_access || [];
    } catch {
      moduleAccess = [];
    }
    const { module_access, must_change_password, ...rest } = row;
    return {
      userId: row.user_id,
      ...rest,
      moduleAccess,
      mustChangePassword: Boolean(must_change_password),
      role: row.role || 'employee',
      phone: row.phone || null,
      department: row.department || null,
      designation: row.designation || null,
    };
  },
};

module.exports = SiteUserModel;
