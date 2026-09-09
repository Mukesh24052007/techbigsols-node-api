const { pool } = require('../config/db');

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
 * Generate the next user_id in the format tbusr001, tbusr002, …
 * Reads the highest existing numeric suffix and increments by 1.
 * Uses a transaction-safe SELECT … FOR UPDATE to prevent duplicates
 * under concurrent inserts.
 *
 * @param {object} conn - An active pool connection
 * @returns {string}
 */
async function generateUserId(conn) {
  const [rows] = await conn.query(
    `SELECT user_id FROM site_users ORDER BY user_id DESC LIMIT 1 FOR UPDATE`
  );

  let next = 1;
  if (rows.length > 0) {
    // user_id format: tbusr001  → extract trailing digits
    const last = rows[0].user_id; // e.g. "tbusr007"
    const num = parseInt(last.replace(/^tbusr/, ''), 10);
    if (!isNaN(num)) next = num + 1;
  }

  // Zero-pad to at least 3 digits (grows naturally beyond 999)
  const padded = String(next).padStart(3, '0');
  return `tbusr${padded}`;
}

const SiteUserModel = {
  MODULES,

  /**
   * Return all site-users (password excluded).
   */
  async findAll() {
    const [rows] = await pool.query(
      `SELECT user_id, fullname, email, module_access, is_active, created_at, updated_at
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
      `SELECT user_id, fullname, email, module_access, is_active, created_at, updated_at
       FROM site_users WHERE user_id = ?`,
      [userId]
    );
    return rows[0] ? SiteUserModel._parse(rows[0]) : null;
  },

  /**
   * Find a site-user by email — includes password (used for auth only).
   */
  async findByEmail(email) {
    const [rows] = await pool.query(
      `SELECT user_id, fullname, email, password, module_access, is_active
       FROM site_users WHERE email = ?`,
      [email]
    );
    return rows[0] ? SiteUserModel._parse(rows[0]) : null;
  },

  /**
   * Create a new site-user with an auto-generated user_id.
   * Runs inside a transaction to guarantee unique id generation.
   *
   * @param {object} data - { fullname, email, password (hashed), moduleAccess[] }
   * @returns {object} - { userId, fullname, email, moduleAccess }
   */
  async create({ fullname, email, password, moduleAccess = [] }) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const userId = await generateUserId(conn);

      await conn.query(
        `INSERT INTO site_users (user_id, fullname, email, password, module_access)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, fullname, email, password, JSON.stringify(moduleAccess)]
      );

      await conn.commit();
      return { userId, fullname, email, moduleAccess };
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
  async update(userId, { fullname, email, password, moduleAccess, is_active }) {
    const fields = [];
    const values = [];

    if (fullname !== undefined)     { fields.push('fullname = ?');      values.push(fullname); }
    if (email !== undefined)        { fields.push('email = ?');         values.push(email); }
    if (password !== undefined)     { fields.push('password = ?');      values.push(password); }
    if (moduleAccess !== undefined) { fields.push('module_access = ?'); values.push(JSON.stringify(moduleAccess)); }
    if (is_active !== undefined)    { fields.push('is_active = ?');     values.push(is_active ? 1 : 0); }

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
   * Parse the JSON module_access column and normalise the id field.
   * Exposes user_id as both `userId` (camelCase) and keeps `user_id` for
   * internal use; strips the raw `module_access` column from the result.
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
    const { module_access, ...rest } = row;
    return { ...rest, moduleAccess };
  },
};

module.exports = SiteUserModel;
