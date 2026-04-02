// scripts/export-to-data-json.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function exportData() {
  const { rows } = await pool.query(`
    SELECT id, value
    FROM cells
    ORDER BY
      regexp_replace(id, '\\D', '', 'g')::int
  `);

  const out = {};
  for (const row of rows) {
    // Convert cells#12 → cell12
    const key = row.id.startsWith('cells#')
      ? `cell${row.id.slice(6)}`
      : row.id;

    out[key] = row.value;
  }

  const outputPath = path.join(__dirname, '..', 'data.json');
  fs.writeFileSync(outputPath, JSON.stringify(out, null, 2));

  console.log(`✅ data.json exported (${rows.length} cells)`);
  await pool.end();
}

exportData().catch(err => {
  console.error('❌ Export failed:', err);
  process.exit(1);
});