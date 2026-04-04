require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

// Detect local vs Render
const isLocal = process.env.DATABASE_URL.includes('localhost');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

function normalizeIndex(key) {
  // Accept "12", "cell12", "cells#12", etc.
  const match = String(key).match(/\d+/);
  return match ? Number(match[0]) : null;
}

async function run() {
  const raw = fs.readFileSync(path.join(__dirname, 'data.json'), 'utf-8');
  const data = JSON.parse(raw);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user', $1, true)", ['seed import']);

    // Optional safety: seed only if table is empty
    // Comment out if you want to overwrite every time.
    const { rows } = await client.query('SELECT COUNT(*)::int AS c FROM cells');
    if (rows[0].c > 0) {
      console.log(`ℹ️ cells table already has ${rows[0].c} rows. Skipping seed to avoid overwrite.`);
      await client.query('COMMIT');
      return process.exit(0);
    }

    let count = 0;
    let skipped = 0;

    for (const [key, value] of Object.entries(data)) {
      const idx = normalizeIndex(key);
      if (idx === null || Number.isNaN(idx)) {
        skipped++;
        continue;
      }

      const cellId = `cells#${idx}`;

      await client.query(
        `
        INSERT INTO cells (id, value)
        VALUES ($1, $2)
        ON CONFLICT (id)
        DO UPDATE SET value = EXCLUDED.value
        `,
        [cellId, String(value ?? '')]
      );

      count++;
    }

    await client.query('COMMIT');
    console.log(`✅ Imported ${count} cells (skipped ${skipped} invalid keys)`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Import failed:', e);
  } finally {
    client.release();
    process.exit(0);
  }
}

run();