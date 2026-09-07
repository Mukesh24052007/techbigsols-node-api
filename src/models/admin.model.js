const { pool } = require('../config/db');

const AdminModel = {
  /**
   * Find an admin by email (includes password for auth checks)
   */
  async findByEmail(email) {
    const [rows] = await pool.query(
      'SELECT id, name, email, password, role, is_active FROM admins WHERE email = ?',
      [email]
    );
    return rows[0] || null;
  },

  /**
   * Find an admin by id (excludes password)
   */
  async findById(id) {
    const [rows] = await pool.query(
      'SELECT id, name, email, role, is_active, created_at FROM admins WHERE id = ?',
      [id]
    );
    return rows[0] || null;
  },

  /**
   * Create a new admin (password must already be hashed before calling this)
   */
  async create({ name, email, password, role = 'admin' }) {
    const [result] = await pool.query(
      'INSERT INTO admins (name, email, password, role) VALUES (?, ?, ?, ?)',
      [name, email, password, role]
    );
    return { id: result.insertId, name, email, role };
  },
};

module.exports = AdminModel;
