const mysql = require('mysql2/promise');

const isProduction = process.env.NODE_ENV === 'production';

const pool = mysql.createPool({
  host:     process.env.DB_HOST || 'localhost',
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'techbigsolutions',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10,
  queueLimit: 0,
  // In production, enable SSL (required by PlanetScale, Aiven, Railway, etc.)
  // Set DB_SSL=false explicitly to disable (e.g. for self-hosted MySQL without SSL)
  // DB_SSL=reject to enforce certificate verification (strict mode)
  ...(isProduction && process.env.DB_SSL !== 'false' && {
    ssl: { rejectUnauthorized: process.env.DB_SSL === 'reject' },
  }),
});

const testConnection = async (retries = 5, delay = 3000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const connection = await pool.getConnection();
      console.log('✅ Database connected successfully');
      connection.release();
      return;
    } catch (error) {
      console.error(`❌ DB connection attempt ${attempt}/${retries} failed: ${error.message}`);
      if (attempt < retries) {
        console.log(`   Retrying in ${delay / 1000}s…`);
        await new Promise((res) => setTimeout(res, delay));
      } else {
        console.error('❌ Could not connect to the database after all retries. Exiting.');
        process.exit(1);
      }
    }
  }
};

module.exports = { pool, testConnection };
