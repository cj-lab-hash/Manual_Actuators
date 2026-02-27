
// scripts/import-data.js
// One-time importer to load ./data.json into PostgreSQL
const path = require('path');
const { pool } = require('../db');

async function main() {
  const dataPath = path.join(process.cwd(), 'data.json');
  let payload;
  try {
    payload = require(dataPath);
  } catch (e) {
    console.error('Could not load data.json at', dataPath);
    process.exit(1);
  }

  const entries = Object.entries(payload);
  console.log(`Importing ${entries.length} items...`);
  for (const [id, value] of entries) {
    await pool.query(
      'INSERT INTO cells (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value',
      [id, value]
    );
  }
  console.log('Import complete.');
  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
