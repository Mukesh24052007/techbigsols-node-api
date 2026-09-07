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

const SiteUserModel = {
  MODULES,

  /**
   * Return all site-users (password excluded).
   */
  async findAll() {
    const [rows] = await pool.query(
      'SELECT id, fullname, email, module_access, is_active, created_at, updated_at FROM site_users'
    );
    return rows.map(SiteUserModel._parse);
  },

  /**
   * Find a single site-user by id (password excluded).
   */
  async findById(id) {
    const [rows] = await pool.query(
      'SELECT id, fullname, email, module_access, is_active, created_at, updated_at FROM site_users WHERE id = ?',
      [id]
    );
    return rows[0] ? SiteUserModel._parse(rows[0]) : null;
  },

  /**
   * Find a site-user by email — includes password (used for auth only).
   */
  async findByEmail(email) {
    const [rows] = await pool.query(
      'SELECT id, fullname, email, password, module_access, is_active FROM site_users WHERE email = ?',
      [email]
    );
    return rows[0] ? SiteUserModel._parse(rows[0]) : null;
  },

  /**
   * Create a new site-user.
   * @param {object} data - { fullname, email, password (hashed), moduleAccess[] }
   */
  async create({ fullname, email, password, moduleAccess = [] }) {
    const [result] = await pool.query(
      'INSERT INTO site_users (fullname, email, password, module_access) VALUES (?, ?, ?, ?)',
      [fullname, email, password, JSON.stringify(moduleAccess)]
    );
    return { id: result.insertId, fullname, email, moduleAccess };
  },

  /**
   * Update an existing site-user.
   * Only supplied fields are changed; password update is optional.
   */
  async update(id, { fullname, email, password, moduleAccess, is_active }) {
    const fields = [];
    const values = [];

    if (fullname !== undefined)     { fields.push('fullname = ?');      values.push(fullname); }
    if (email !== undefined)        { fields.push('email = ?');         values.push(email); }
    if (password !== undefined)     { fields.push('password = ?');      values.push(password); }
    if (moduleAccess !== undefined) { fields.push('module_access = ?'); values.push(JSON.stringify(moduleAccess)); }
    if (is_active !== undefined)    { fields.push('is_active = ?');     values.push(is_active ? 1 : 0); }

    if (fields.length === 0) return false;

    values.push(id);
    const [result] = await pool.query(
      `UPDATE site_users SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    return result.affectedRows > 0;
  },

  /**
   * Delete a site-user by id.
   */
  async remove(id) {
    const [result] = await pool.query('DELETE FROM site_users WHERE id = ?', [id]);
    return result.affectedRows > 0;
  },

  /**
   * Parse the JSON module_access column into a JS array.
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
    return { ...row, moduleAccess, module_access: undefined };
  },
};

module.exports = SiteUserModel;
