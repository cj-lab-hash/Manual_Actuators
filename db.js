// db.js
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set.');
}

// Automatically detect local vs cloud
const isLocal = process.env.DATABASE_URL.includes('localhost');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // Use SSL only on cloud (Render)
  ssl: isLocal ? false : { rejectUnauthorized: false },

  // ✅ Force this app to use the manual_actuators schema first
  // This sets search_path when the connection is created
  options: '-c search_path=manual_actuators,public',  // [1](https://github.com/cj-lab-hash/Manual_Actuators/network)[2](https://geekdecoder.com/download-and-run-a-shell-script-from-github/)

  // Safe pool settings
  max: parseInt(process.env.PGPOOL_MAX || '5', 10),
  idleTimeoutMillis: 10000,
});

module.exports = { pool };