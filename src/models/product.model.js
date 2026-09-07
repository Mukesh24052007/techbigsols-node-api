const { pool } = require('../config/db');

/**
 * Specifications are stored as a JSON column.
 * We always parse on read and stringify on write so the rest
 * of the app works with plain JS arrays: [{ key, value }, ...]
 */
const parseSpecs = (row) => {
  if (!row) return null;
  return {
    ...row,
    specifications: row.specifications
      ? (typeof row.specifications === 'string'
          ? JSON.parse(row.specifications)
          : row.specifications)
      : [],
  };
};

const ProductModel = {
  // ── READ ──────────────────────────────────────────────────────────────────

  async findAll() {
    const [rows] = await pool.query(`
      SELECT
        id, name, short_description, full_description,
        specifications, image_url,
        price, category, badge, rating, in_stock,
        created_at, updated_at
      FROM products
      ORDER BY created_at DESC
    `);
    return rows.map(parseSpecs);
  },

  async findById(id) {
    const [rows] = await pool.query(`
      SELECT
        id, name, short_description, full_description,
        specifications, image_url,
        price, category, badge, rating, in_stock,
        created_at, updated_at
      FROM products
      WHERE id = ?
    `, [id]);
    return parseSpecs(rows[0] || null);
  },

  // ── CREATE ────────────────────────────────────────────────────────────────

  async create({
    name,
    short_description,
    full_description,
    specifications = [],
    image_url = null,
    price,
    category = null,
    badge = null,
    rating = 0,
    in_stock = 1,
  }) {
    const [result] = await pool.query(`
      INSERT INTO products
        (name, short_description, full_description, specifications,
         image_url, price, category, badge, rating, in_stock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      name,
      short_description,
      full_description,
      JSON.stringify(specifications),
      image_url,
      price,
      category,
      badge,
      rating,
      in_stock,
    ]);

    return this.findById(result.insertId);
  },

  // ── UPDATE ────────────────────────────────────────────────────────────────

  async update(id, fields) {
    const allowed = [
      'name', 'short_description', 'full_description', 'specifications',
      'image_url', 'price', 'category', 'badge', 'rating', 'in_stock',
    ];

    const updates = [];
    const values  = [];

    for (const key of allowed) {
      if (key in fields) {
        updates.push(`${key} = ?`);
        values.push(
          key === 'specifications'
            ? JSON.stringify(fields[key])
            : fields[key]
        );
      }
    }

    if (updates.length === 0) return false;

    values.push(id);
    const [result] = await pool.query(
      `UPDATE products SET ${updates.join(', ')} WHERE id = ?`,
      values
    );
    return result.affectedRows > 0;
  },

  // ── DELETE ────────────────────────────────────────────────────────────────

  async remove(id) {
    const [result] = await pool.query(
      'DELETE FROM products WHERE id = ?',
      [id]
    );
    return result.affectedRows > 0;
  },
};

module.exports = ProductModel;
