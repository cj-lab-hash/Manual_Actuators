const express = require('express');
const path = require('path');
const cors = require('cors');
const { pool } = require('./db');

// ----- DB Schema Init (runs on boot) -----
async function initDatabase() {
  const schema = `
  CREATE TABLE IF NOT EXISTS actuators (
    id SERIAL PRIMARY KEY,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS actuators_audit (
    audit_id BIGSERIAL PRIMARY KEY,
    row_id INT,
    op TEXT NOT NULL,
    changed_by TEXT,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    old_data JSONB,
    new_data JSONB
  );

  CREATE OR REPLACE FUNCTION audit_actuators()
  RETURNS TRIGGER AS $$
  DECLARE
    actor TEXT := current_setting('app.user', true);
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO actuators_audit(op, row_id, changed_by, old_data, new_data)
      VALUES ('INSERT', NEW.id, actor, NULL, NEW.data);
      RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
      INSERT INTO actuators_audit(op, row_id, changed_by, old_data, new_data)
      VALUES ('UPDATE', NEW.id, actor, OLD.data, NEW.data);
      RETURN NEW;

    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO actuators_audit(op, row_id, changed_by, old_data, new_data)
      VALUES ('DELETE', OLD.id, actor, OLD.data, NULL);
      RETURN OLD;
    END IF;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_audit_actuators ON actuators;
  CREATE TRIGGER trg_audit_actuators
  AFTER INSERT OR UPDATE OR DELETE ON actuators
  FOR EACH ROW EXECUTE FUNCTION audit_actuators();

  CREATE INDEX IF NOT EXISTS idx_act_audit_row_id ON actuators_audit (row_id);
  CREATE INDEX IF NOT EXISTS idx_act_audit_changed_at ON actuators_audit (changed_at);
  `;

  try {
    await pool.query(schema);
    console.log('📦 Schema initialized (actuators + audit).');
  } catch (err) {
    console.error('❌ Schema init error:', err);
  }
}
// call it immediately during startup
initDatabase();
// -----------------------------------------

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --------------------------
// Save / update a cell (CELLS table - not audited by actuators trigger)
// NOTE: This is a POST endpoint. Opening it in a browser as GET will show "Cannot GET /api/save".
app.post('/api/save', async (req, res) => {
  try {
    const { index, value, editedBy } = req.body;
    if (index === undefined) return res.status(400).json({ message: 'index is required' });

    const cellId = `cells#${index}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Set per-transaction actor (safe with dotted name via set_config)
      await client.query('SELECT set_config($1, $2, true);', ['app.user', editedBy || 'unknown']);
      await client.query(
        'INSERT INTO cells (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value',
        [cellId, value]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ message: 'Data saved successfully!' });
  } catch (err) {
    console.error('Error saving to DB:', err);
    res.status(500).json({ message: 'Error saving data' });
  }
});

// Load all cells (normalize keys so the UI sees "0","1","2"... instead of "cells#0"...)
app.get('/api/data', async (_req, res) => {
  try {
    const result = await pool.query('SELECT id, value FROM cells');
    const data = {};

    for (const row of result.rows) {
      // Normalize: "cells#12" -> "12"
      const normalizedKey = String(row.id).startsWith('cells#')
        ? String(row.id).slice('cells#'.length)
        : String(row.id);
      data[normalizedKey] = row.value;
    }

    res.json(data);
  } catch (err) {
    console.error('Error fetching from DB:', err);
    res.status(500).json({ message: 'Error reading data' });
  }
});

// --------------------------
// DEV/VERIFY ROUTES

// Check schema objects exist (you already used this)
app.get('/dbcheck', async (_req, res) => {
  try {
    const q = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema='public'
        AND table_name IN ('actuators','actuators_audit')
      ORDER BY table_name;
    `;
    const { rows } = await pool.query(q);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Insert a demo row into "actuators" and capture "who"
app.get('/demo-insert', async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true);', ['app.user', 'demo-user']);
    const q = await client.query(
      `INSERT INTO actuators(data) VALUES ($1) RETURNING id`,
      [{ part_no: 'X-123', status: 'new', torque: 5 }]
    );
    await client.query('COMMIT');
    res.json({ inserted_id: q.rows[0].id });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Show latest audit entries (from actuators_audit)
app.get('/audit-latest', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT audit_id, row_id, op, changed_by, changed_at, old_data, new_data
      FROM actuators_audit
      ORDER BY changed_at DESC
      LIMIT 10
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/cells-check', async (_req, res) => {
  try {
    const q = `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='cells'
      ORDER BY ordinal_position;
    `;
    const { rows } = await pool.query(q);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// --------------------------
const PORT = process.env.PORT || 3003;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  server.close(async () => {
    try { await pool.end(); } catch {}
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);


