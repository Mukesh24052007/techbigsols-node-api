// Load .env only in local development.
// On AWS Elastic Beanstalk, env vars are injected by the platform via eb setenv.
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
}

const bcrypt = require('bcryptjs');
const { pool } = require('./db');

// ── Seed data ─────────────────────────────────────────────────────────────────
// Credentials are read from environment variables so nothing sensitive is
// committed to the repo.
//
// Set these on AWS before deploying:
//   eb setenv SEED_ADMIN_NAME="Super Admin" \
//             SEED_ADMIN_EMAIL="admin@techbigsolutions.in" \
//             SEED_ADMIN_PASSWORD="YourStrongPassword123!"
//
// For local dev, add the same keys to your .env file.
//
// If SEED_ADMIN_EMAIL is not set, the script exits without doing anything
// so it is always safe to run (and re-run) in any environment.

const ADMINS = [
  {
    name:     process.env.SEED_ADMIN_NAME     || 'Super Admin',
    email:    process.env.SEED_ADMIN_EMAIL,          // required — no default
    password: process.env.SEED_ADMIN_PASSWORD,       // required — no default
    role:     'superadmin',
  },
];

const seed = async () => {
  // Guard: skip silently if required vars are missing
  const missing = ADMINS.filter((a) => !a.email || !a.password);
  if (missing.length > 0) {
    console.log('ℹ️  Seed skipped — SEED_ADMIN_EMAIL and/or SEED_ADMIN_PASSWORD not set.');
    console.log('   Set them via: eb setenv SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=...');
    process.exit(0);
  }

  try {
    for (const admin of ADMINS) {
      // Check if this admin already exists — seed is fully idempotent
      const [existing] = await pool.query(
        'SELECT id FROM admins WHERE email = ? LIMIT 1',
        [admin.email]
      );

      if (existing.length > 0) {
        console.log(`ℹ️  Admin already exists, skipping: ${admin.email}`);
        continue;
      }

      // Hash password with bcrypt (same cost factor used in the rest of the app)
      const hashedPassword = await bcrypt.hash(admin.password, 12);

      await pool.query(
        'INSERT INTO admins (name, email, password, role) VALUES (?, ?, ?, ?)',
        [admin.name, admin.email, hashedPassword, admin.role]
      );

      console.log(`✅ Admin seeded: ${admin.email} (role: ${admin.role})`);
    }

    console.log('\n🎉 Seed completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  }
};

seed();
