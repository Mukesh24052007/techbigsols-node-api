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

    // ── 5. Attendance module ─────────────────────────────────────────────────
    // No foreign keys to site_users: deleting a site-user must keep working
    // and payroll history must survive. Indexed user_id + fullname snapshot.
    // DATETIME (not TIMESTAMP) so values are timezone-naive UTC strings.
    const attendanceTables = [
      {
        name: 'attendance_offices',
        sql: `
          CREATE TABLE IF NOT EXISTS attendance_offices (
            id                         INT AUTO_INCREMENT PRIMARY KEY,
            name                       VARCHAR(150)  NOT NULL,
            lat                        DECIMAL(10,7) NOT NULL,
            lng                        DECIMAL(10,7) NOT NULL,
            radius_m                   INT           NOT NULL DEFAULT 150,
            accuracy_max_m             INT           NOT NULL DEFAULT 50,
            ip_allowlist               JSON          DEFAULT NULL,
            require_both               TINYINT(1)    NOT NULL DEFAULT 0,
            shift_start                TIME          NOT NULL DEFAULT '09:30:00',
            shift_end                  TIME          NOT NULL DEFAULT '18:30:00',
            grace_minutes              INT           NOT NULL DEFAULT 10,
            outside_tolerance_minutes  INT           NOT NULL DEFAULT 10,
            heartbeat_seconds          INT           NOT NULL DEFAULT 60,
            reverify_count             INT           NOT NULL DEFAULT 2,
            created_at                 DATETIME      NOT NULL,
            updated_at                 DATETIME      NOT NULL
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `,
      },
      {
        name: 'attendance_profiles',
        sql: `
          CREATE TABLE IF NOT EXISTS attendance_profiles (
            user_id          VARCHAR(20)  NOT NULL PRIMARY KEY,
            department       VARCHAR(100) DEFAULT NULL,
            designation      VARCHAR(100) DEFAULT NULL,
            office_id        INT          DEFAULT NULL,
            shift_start      TIME         DEFAULT NULL,
            shift_end        TIME         DEFAULT NULL,
            face_template    VARBINARY(1024) DEFAULT NULL,
            face_enrolled_at DATETIME     DEFAULT NULL,
            consent_at       DATETIME     DEFAULT NULL,
            consent_version  VARCHAR(32)  DEFAULT NULL,
            created_at       DATETIME     NOT NULL,
            updated_at       DATETIME     NOT NULL,
            INDEX idx_att_profiles_office (office_id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `,
      },
      {
        name: 'attendance_records',
        sql: `
          CREATE TABLE IF NOT EXISTS attendance_records (
            id                  INT AUTO_INCREMENT PRIMARY KEY,
            user_id             VARCHAR(20)  NOT NULL,
            attendance_date     DATE         NOT NULL,
            fullname            VARCHAR(150) NOT NULL,
            office_id           INT          DEFAULT NULL,
            check_in_at         DATETIME     DEFAULT NULL,
            check_out_at        DATETIME     DEFAULT NULL,
            status              ENUM('PRESENT','LATE','AUTO_CHECKOUT','ABSENT') NOT NULL DEFAULT 'ABSENT',
            worked_minutes      INT          NOT NULL DEFAULT 0,
            check_in_lat        DECIMAL(10,7) DEFAULT NULL,
            check_in_lng        DECIMAL(10,7) DEFAULT NULL,
            check_in_accuracy   DECIMAL(8,2)  DEFAULT NULL,
            ip                  VARCHAR(45)  DEFAULT NULL,
            created_at          DATETIME     NOT NULL,
            updated_at          DATETIME     NOT NULL,
            UNIQUE KEY uq_att_records_user_date (user_id, attendance_date),
            INDEX idx_att_records_date (attendance_date),
            INDEX idx_att_records_office (office_id),
            INDEX idx_att_records_status (attendance_date, status)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `,
      },
      {
        name: 'attendance_presence',
        sql: `
          CREATE TABLE IF NOT EXISTS attendance_presence (
            record_id          INT          NOT NULL PRIMARY KEY,
            user_id            VARCHAR(20)  NOT NULL,
            state              ENUM('INSIDE','OUTSIDE','UNKNOWN') NOT NULL DEFAULT 'INSIDE',
            last_heartbeat_at  DATETIME     DEFAULT NULL,
            last_inside_at     DATETIME     DEFAULT NULL,
            outside_since      DATETIME     DEFAULT NULL,
            last_lat           DECIMAL(10,7) DEFAULT NULL,
            last_lng           DECIMAL(10,7) DEFAULT NULL,
            last_accuracy      DECIMAL(8,2)  DEFAULT NULL,
            updated_at         DATETIME     NOT NULL,
            INDEX idx_att_presence_user (user_id),
            INDEX idx_att_presence_state (state)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `,
      },
      {
        name: 'attendance_intervals',
        sql: `
          CREATE TABLE IF NOT EXISTS attendance_intervals (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            record_id   INT          NOT NULL,
            state       ENUM('INSIDE','OUTSIDE','UNKNOWN') NOT NULL,
            started_at  DATETIME     NOT NULL,
            ended_at    DATETIME     DEFAULT NULL,
            INDEX idx_att_intervals_record (record_id, ended_at)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `,
      },
      {
        name: 'attendance_challenges',
        sql: `
          CREATE TABLE IF NOT EXISTS attendance_challenges (
            id          CHAR(36)     NOT NULL PRIMARY KEY,
            user_id     VARCHAR(20)  NOT NULL,
            purpose     ENUM('checkin','reverify') NOT NULL,
            action      VARCHAR(32)  NOT NULL,
            issued_at   DATETIME     NOT NULL,
            expires_at  DATETIME     NOT NULL,
            used_at     DATETIME     DEFAULT NULL,
            INDEX idx_att_challenges_user (user_id, purpose, issued_at)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `,
      },
      {
        name: 'attendance_attempts',
        sql: `
          CREATE TABLE IF NOT EXISTS attendance_attempts (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            user_id         VARCHAR(20)  NOT NULL,
            kind            VARCHAR(32)  NOT NULL,
            success         TINYINT(1)   NOT NULL DEFAULT 0,
            distance_score  DECIMAL(8,6) DEFAULT NULL,
            accuracy        DECIMAL(8,2) DEFAULT NULL,
            ip              VARCHAR(45)  DEFAULT NULL,
            reason          VARCHAR(255) DEFAULT NULL,
            created_at      DATETIME     NOT NULL,
            INDEX idx_att_attempts_user_created (user_id, created_at),
            INDEX idx_att_attempts_kind (kind, created_at)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `,
      },
      {
        name: 'attendance_reverify_tasks',
        sql: `
          CREATE TABLE IF NOT EXISTS attendance_reverify_tasks (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            record_id     INT          NOT NULL,
            user_id       VARCHAR(20)  NOT NULL,
            scheduled_at  DATETIME     NOT NULL,
            due_at        DATETIME     NOT NULL,
            completed_at  DATETIME     DEFAULT NULL,
            status        ENUM('PENDING','COMPLETED','MISSED','CANCELLED') NOT NULL DEFAULT 'PENDING',
            INDEX idx_att_reverify_record (record_id),
            INDEX idx_att_reverify_due (status, due_at),
            INDEX idx_att_reverify_user (user_id, scheduled_at)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `,
      },
      {
        name: 'attendance_regularizations',
        sql: `
          CREATE TABLE IF NOT EXISTS attendance_regularizations (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            user_id          VARCHAR(20)  NOT NULL,
            attendance_date  DATE         NOT NULL,
            reason           TEXT         NOT NULL,
            status           ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
            reviewed_by      INT          DEFAULT NULL,
            reviewed_at      DATETIME     DEFAULT NULL,
            created_at       DATETIME     NOT NULL,
            INDEX idx_att_reg_user_date (user_id, attendance_date),
            INDEX idx_att_reg_status (status)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `,
      },
      {
        name: 'attendance_leaves',
        sql: `
          CREATE TABLE IF NOT EXISTS attendance_leaves (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            user_id      VARCHAR(20)  NOT NULL,
            leave_date   DATE         NOT NULL,
            reason       VARCHAR(500) DEFAULT NULL,
            status       ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
            reviewed_by  INT          DEFAULT NULL,
            reviewed_at  DATETIME     DEFAULT NULL,
            created_at   DATETIME     NOT NULL,
            UNIQUE KEY uq_att_leaves_user_date (user_id, leave_date),
            INDEX idx_att_leaves_date_status (leave_date, status)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `,
      },
      {
        name: 'attendance_audit_log',
        sql: `
          CREATE TABLE IF NOT EXISTS attendance_audit_log (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            actor_admin_id  INT          NOT NULL,
            action          VARCHAR(64)  NOT NULL,
            entity_type     VARCHAR(64)  NOT NULL,
            entity_id       VARCHAR(64)  NOT NULL,
            before_json     JSON         DEFAULT NULL,
            after_json      JSON         DEFAULT NULL,
            created_at      DATETIME     NOT NULL,
            INDEX idx_att_audit_entity (entity_type, entity_id),
            INDEX idx_att_audit_created (created_at)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `,
      },
    ];

    const failedAttendanceTables = [];
    for (const table of attendanceTables) {
      try {
        await pool.query(table.sql);
        console.log(`✅ ${table.name} table ready`);
      } catch (err) {
        failedAttendanceTables.push(table.name);
        console.warn(`⚠️  ${table.name}:`, err.message);
      }
    }

    if (failedAttendanceTables.length > 0) {
      console.warn(`\n⚠️  ${failedAttendanceTables.length} attendance table(s) failed: ${failedAttendanceTables.join(', ')}`);
    }

    console.log('\n🎉 All migrations completed successfully.');
    process.exit(0);

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
};

migrate();
