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
    // user_id uses the format tbusr001, tbusr002, … generated in application code

    // Create the table fresh if it doesn't exist yet
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

    // --- Schema upgrade: migrate old `id INT` column to `user_id VARCHAR` ---
    // Check whether the legacy `id` column still exists
    const [legacyCols] = await pool.query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'site_users'
        AND COLUMN_NAME  = 'id'
    `);

    if (legacyCols.length > 0) {
      console.log('⚙️  Upgrading site_users: replacing id column with user_id …');

      // Check which columns already exist so each step is idempotent (safe to re-run)
      const [allCols] = await pool.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'site_users'
      `);
      const colNames = allCols.map((c) => c.COLUMN_NAME);

      const hasUserIdCol = colNames.includes('user_id');
      const hasIdCol     = colNames.includes('id');

      // Step 1 — Strip AUTO_INCREMENT from id so we can demote it from PK
      if (hasIdCol) {
        await pool.query(`ALTER TABLE site_users MODIFY COLUMN id INT NOT NULL`);
        console.log('  ✓ AUTO_INCREMENT removed from id');
      }

      // Step 2 — Drop the old primary key if one still exists
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

      // Step 3 — Add user_id column only if it was not added by a previous run
      if (!hasUserIdCol) {
        await pool.query(`ALTER TABLE site_users ADD COLUMN user_id VARCHAR(20) NULL`);
        console.log('  ✓ user_id column added');
      }

      // Step 4 — Backfill user_id from old numeric id where still empty
      if (hasIdCol) {
        await pool.query(`
          UPDATE site_users
          SET user_id = CONCAT('tbusr', LPAD(id, 3, '0'))
          WHERE user_id IS NULL OR user_id = ''
        `);
        console.log('  ✓ user_id values backfilled');
      }

      // Step 5 — Promote user_id to NOT NULL primary key
      await pool.query(`
        ALTER TABLE site_users
          MODIFY COLUMN user_id VARCHAR(20) NOT NULL,
          ADD PRIMARY KEY (user_id)
      `);
      console.log('  ✓ user_id set as primary key');

      // Step 6 — Drop the old id column
      if (hasIdCol) {
        await pool.query(`ALTER TABLE site_users DROP COLUMN id`);
        console.log('  ✓ Old id column dropped');
      }

      console.log('✅ site_users schema upgrade complete: user_id is now the primary key');
    }

    console.log('✅ Migration complete: site_users table ready');

    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
};

migrate();
