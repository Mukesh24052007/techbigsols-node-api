require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { pool } = require('./db');

const migrate = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(100)  NOT NULL,
        email      VARCHAR(150)  NOT NULL UNIQUE,
        password   VARCHAR(255)  NOT NULL,
        created_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Migration complete: users table ready');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(100)  NOT NULL,
        email      VARCHAR(150)  NOT NULL UNIQUE,
        password   VARCHAR(255)  NOT NULL,
        role       ENUM('superadmin', 'admin') NOT NULL DEFAULT 'admin',
        is_active  TINYINT(1)    NOT NULL DEFAULT 1,
        created_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Migration complete: admins table ready');

    // products — basic info, specs (JSON key/value pairs), image, pricing & meta
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id                INT AUTO_INCREMENT PRIMARY KEY,

        -- Basic Information
        name              VARCHAR(255)   NOT NULL,
        short_description VARCHAR(500)   NOT NULL,
        full_description  TEXT           NOT NULL,

        -- Specifications (stored as JSON array of { key, value } objects)
        specifications    JSON           DEFAULT NULL,

        -- Media
        image_url         VARCHAR(1000)  DEFAULT NULL,

        -- Pricing & Meta
        price             DECIMAL(10,2)  NOT NULL DEFAULT 0.00,
        category          VARCHAR(100)   DEFAULT NULL,
        badge             VARCHAR(100)   DEFAULT NULL,
        rating            DECIMAL(3,2)   NOT NULL DEFAULT 0.00,
        in_stock          TINYINT(1)     NOT NULL DEFAULT 1,

        created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Migration complete: products table ready');

    // Drop reviews_count column if it still exists (cleanup migration)
    await pool.query(`
      ALTER TABLE products
      DROP COLUMN IF EXISTS reviews_count
    `);
    console.log('✅ Migration complete: reviews_count column removed');

    // site_users — users managed through the admin user-master portal
    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_users (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        fullname      VARCHAR(150)  NOT NULL,
        email         VARCHAR(150)  NOT NULL UNIQUE,
        password      VARCHAR(255)  NOT NULL,
        module_access JSON          NOT NULL DEFAULT (JSON_ARRAY()),
        is_active     TINYINT(1)    NOT NULL DEFAULT 1,
        created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Migration complete: site_users table ready');

    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
};

migrate();
