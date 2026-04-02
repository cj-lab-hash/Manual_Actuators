// server.js
require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const { pool } = require('./db');

const app = express();

/* ===========================================
   Middleware
=========================================== */
app.use(express.json({ limit: '10kb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

/* ===========================================
   Auth (protect write operations only)
=========================================== */
const AUTH_TOKEN = process.env.AUTH_TOKEN;
if (AUTH_TOKEN) {
  app.use((req, res, next) => {
    // Read-only endpoints are public
    if (req.method === 'GET') return next();

    const token = req.headers['authorization']?.split(' ')[1];
    if (token !== AUTH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });
}

/* ===========================================
   Database Schema Init
=========================================== */
async function initDatabase() {
  const schema = `
  CREATE TABLE IF NOT EXISTS cells (
    id TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS cells_audit (
    audit_id BIGSERIAL PRIMARY KEY,
    cell_id TEXT NOT NULL,
    op TEXT NOT NULL,
    changed_by TEXT,
    changed_at TIMESTAMPTZ DEFAULT now(),
    old_value TEXT,
    new_value TEXT
  );

  CREATE OR REPLACE FUNCTION audit_cells_changes()
  RETURNS TRIGGER AS $$
  DECLARE actor TEXT := current_setting('app.user', true);
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO cells_audit(cell_id, op, changed_by, new_value)
      VALUES (NEW.id, 'INSERT', actor, NEW.value);
    ELSIF TG_OP = 'UPDATE' THEN
      INSERT INTO cells_audit(cell_id, op, changed_by, old_value, new_value)
      VALUES (NEW.id, 'UPDATE', actor, OLD.value, NEW.value);
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_audit_cells ON cells;
  CREATE TRIGGER trg_audit_cells
  AFTER INSERT OR UPDATE ON cells
  FOR EACH ROW EXECUTE FUNCTION audit_cells_changes();
  `;

  await pool.query(schema);
}

/* ===========================================
   API Routes
=========================================== */

// Save or update a cell
app.post('/api/save', async (req, res) => {
  const { index, value, editedBy } = req.body;
  if (typeof index !== 'number' || typeof value !== 'string') {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const cellId = `cells#${index}`;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user', $1, true)`,
      [editedBy || 'unknown']
    );
    await client.query(
      `
      INSERT INTO cells (id, value)
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE
      SET value = EXCLUDED.value
      `,
      [cellId, value]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Load all cell data
app.get('/api/data', async (_req, res) => {
  const { rows } = await pool.query(`SELECT id, value FROM cells`);
  const data = {};
  for (const r of rows) {
    data[r.id.replace('cells#', '')] = r.value;
  }
  res.json(data);
});

// Simple health check
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

/* ===========================================
   Start Server (deterministic startup)
=========================================== */
const PORT = process.env.PORT || 10000;

(async () => {
  try {
    console.log('🚀 Starting application...');
    await initDatabase();
    app.listen(PORT, () =>
      console.log(`✅ Server running on port ${PORT}`)
    );
  } catch (err) {
    console.error('❌ Fatal startup error:', err);
    process.exit(1);
  }
})();