// Load .env only in local development.
// On AWS Elastic Beanstalk, environment variables are injected by the platform
// (via eb setenv) — no .env file exists on the instance and none is needed.
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
}
const { pool } = require('./db');

// ── Helper: check if a column exists in a table ───────────────────────────────
// Uses INFORMATION_SCHEMA — compatible with MySQL 5.7 and 8.x.
// "DROP COLUMN IF EXISTS" / "ADD COLUMN IF NOT EXISTS" are MySQL 8.0+ only,
// so we always gate with this check instead.
const columnExists = async (table, column) => {
  const [rows] = await pool.query(
    `SELECT 1
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = ?
       AND COLUMN_NAME  = ?
     LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
};

// ── Helper: check if a table exists ──────────────────────────────────────────
const tableExists = async (table) => {
  const [rows] = await pool.query(
    `SELECT 1
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = ?
     LIMIT 1`,
    [table]
  );
  return rows.length > 0;
};

const migrate = async () => {
  try {

    // ── 1. users ─────────────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(100)  NOT NULL,
        email      VARCHAR(150)  NOT NULL UNIQUE,
        password   VARCHAR(255)  NOT NULL,
        created_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ users table ready');

    // ── 2. admins ─────────────────────────────────────────────────────────────
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
    console.log('✅ admins table ready');

    // ── 3. products ───────────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        name              VARCHAR(255)   NOT NULL,
        short_description VARCHAR(500)   NOT NULL,
        full_description  TEXT           NOT NULL,
        specifications    JSON           DEFAULT NULL,
        image_url         VARCHAR(1000)  DEFAULT NULL,
        price             DECIMAL(10,2)  NOT NULL DEFAULT 0.00,
        category          VARCHAR(100)   DEFAULT NULL,
        badge             VARCHAR(100)   DEFAULT NULL,
        rating            DECIMAL(3,2)   NOT NULL DEFAULT 0.00,
        in_stock          TINYINT(1)     NOT NULL DEFAULT 1,
        created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ products table ready');

    // ── 3a. Drop legacy reviews_count column (MySQL 5.7 + 8.x safe) ──────────
    // "ALTER TABLE ... DROP COLUMN IF EXISTS" is MySQL 8.0+ only — crashes on 5.7.
    // We gate with an INFORMATION_SCHEMA check instead.
    try {
      if (await columnExists('products', 'reviews_count')) {
        await pool.query(`ALTER TABLE products DROP COLUMN reviews_count`);
        console.log('✅ products: legacy reviews_count column removed');
      } else {
        console.log('ℹ️  products: reviews_count column not present — skipping drop');
      }
    } catch (err) {
      // Non-fatal — log and continue so the rest of the migration still runs
      console.warn('⚠️  products: could not drop reviews_count —', err.message);
    }

    // ── 4. site_users ─────────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_users (
        user_id       VARCHAR(20)   NOT NULL PRIMARY KEY,
        fullname      VARCHAR(150)  NOT NULL,
        email         VARCHAR(150)  NOT NULL UNIQUE,
        password      VARCHAR(255)  NOT NULL,
        module_access JSON          NOT NULL DEFAULT (JSON_ARRAY()),
        is_active     TINYINT(1)    NOT NULL DEFAULT 1,
        created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ site_users table ready');

    // ── 4a. Schema upgrade: migrate old `id INT` PK → `user_id VARCHAR` ──────
    // Each step is wrapped individually so a partial-upgrade from a previous
    // failed run doesn't crash — every step is idempotent.
    if (await columnExists('site_users', 'id')) {
      console.log('⚙️  site_users: upgrading id → user_id …');

      // Step 1 — Strip AUTO_INCREMENT so we can demote id from PK
      try {
        await pool.query(`ALTER TABLE site_users MODIFY COLUMN id INT NOT NULL`);
        console.log('  ✓ AUTO_INCREMENT removed from id');
      } catch (err) {
        console.warn('  ⚠️  MODIFY id:', err.message);
      }

      // Step 2 — Drop old PK (only if one still exists)
      try {
        const [pkRows] = await pool.query(`
          SELECT CONSTRAINT_NAME
          FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA    = DATABASE()
            AND TABLE_NAME      = 'site_users'
            AND CONSTRAINT_TYPE = 'PRIMARY KEY'
        `);
        if (pkRows.length > 0) {
          await pool.query(`ALTER TABLE site_users DROP PRIMARY KEY`);
          console.log('  ✓ Old primary key dropped');
        }
      } catch (err) {
        console.warn('  ⚠️  DROP PRIMARY KEY:', err.message);
      }

      // Step 3 — Add user_id column if not already added by a previous run
      try {
        if (!(await columnExists('site_users', 'user_id'))) {
          await pool.query(`ALTER TABLE site_users ADD COLUMN user_id VARCHAR(20) NULL`);
          console.log('  ✓ user_id column added');
        }
      } catch (err) {
        console.warn('  ⚠️  ADD COLUMN user_id:', err.message);
      }

      // Step 4 — Backfill user_id from old numeric id where still empty
      try {
        await pool.query(`
          UPDATE site_users
          SET user_id = CONCAT('tbusr', LPAD(id, 3, '0'))
          WHERE user_id IS NULL OR user_id = ''
        `);
        console.log('  ✓ user_id values backfilled');
      } catch (err) {
        console.warn('  ⚠️  Backfill user_id:', err.message);
      }

      // Step 5 — Promote user_id to NOT NULL primary key
      try {
        await pool.query(`
          ALTER TABLE site_users
            MODIFY COLUMN user_id VARCHAR(20) NOT NULL,
            ADD PRIMARY KEY (user_id)
        `);
        console.log('  ✓ user_id set as primary key');
      } catch (err) {
        console.warn('  ⚠️  MODIFY user_id / ADD PRIMARY KEY:', err.message);
      }

      // Step 6 — Drop the old id column
      try {
        if (await columnExists('site_users', 'id')) {
          await pool.query(`ALTER TABLE site_users DROP COLUMN id`);
          console.log('  ✓ Old id column dropped');
        }
      } catch (err) {
        console.warn('  ⚠️  DROP COLUMN id:', err.message);
      }

      console.log('✅ site_users schema upgrade complete');
    }

    console.log('\n🎉 All migrations completed successfully.');
    process.exit(0);

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
};

migrate();
