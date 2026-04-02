// db.js
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set.');
}

// ✅ Automatically detect local vs cloud
const isLocal = process.env.DATABASE_URL.includes('localhost');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // ✅ Use SSL only on cloud (Render)
  ssl: isLocal ? false : { rejectUnauthorized: false },

  // ✅ Safe pool settings
  max: parseInt(process.env.PGPOOL_MAX || '5', 10),
  idleTimeoutMillis: 10000,
});

module.exports = { pool };
