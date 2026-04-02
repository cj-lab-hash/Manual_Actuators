const fs = require('fs');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const raw = fs.readFileSync('./data.json', 'utf-8');
  const data = JSON.parse(raw);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // OPTIONAL: identify importer in audit logs
    await client.query(
      "SELECT set_config('app.user', $1, true)",
      ['data.json import']
    );

    let count = 0;

    for (const [index, value] of Object.entries(data)) {
      const cellId = `cells#${index}`;

      await client.query(
        `
        INSERT INTO cells (id, value)
        VALUES ($1, $2)
        ON CONFLICT (id)
        DO UPDATE SET value = EXCLUDED.value
        `,
        [cellId, String(value)]
      );

      count++;
    }

    await client.query('COMMIT');
    console.log(`✅ Imported ${count} cells successfully`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Import failed:', err);
  } finally {
    client.release();
    process.exit(0);
  }
}

run();
