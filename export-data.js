// export-data.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

const isLocal = process.env.DATABASE_URL.includes('localhost');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

(async () => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT id, value FROM cells');
    const out = {};

    for (const r of rows) {
      // Extract numeric index from id like "cells#12" or "cell12"
      const m = String(r.id).match(/\d+/);
      if (!m) continue;
      out[m[0]] = r.value ?? '';
    }

    fs.writeFileSync(
      path.join(__dirname, 'data.json'),
      JSON.stringify(out, null, 2),
      'utf-8'
    );

    console.log(`✅ Exported ${Object.keys(out).length} cells to data.json`);
  } catch (e) {
    console.error('❌ Export failed:', e);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
})();