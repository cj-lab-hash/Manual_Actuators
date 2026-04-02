require('dotenv').config();
const { pool } = require('../db');
const fs = require('fs');

(async () => {
  const { rows } = await pool.query('SELECT id, value FROM cells');
  const out = {};
  rows.forEach(r => out[r.id] = r.value);

  fs.writeFileSync(
    `backups/cells_${Date.now()}.json`,
    JSON.stringify(out, null, 2)
  );

  console.log('✅ cells exported');
  process.exit(0);
})();