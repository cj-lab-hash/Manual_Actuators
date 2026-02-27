// db.js (PostgreSQL)
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Configure it in Render (or a local .env).');
}

// Keep the pool small on Render free plans
const pool = new Pool({
  connectionString,
  // Managed Postgres typically requires SSL; allow self-signed chain in hosted envs
  ssl: { rejectUnauthorized: false },
  max: parseInt(process.env.PGPOOL_MAX || '5', 10),
  idleTimeoutMillis: 10000,
});

// Create table on startup if it doesn't exist
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cells (
      id TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}
init().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

module.exports = { pool };
