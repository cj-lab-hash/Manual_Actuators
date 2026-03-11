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

// Save / update a cell
app.post('/api/save', async (req, res) => {
  try {
    const { index, value, editedBy } = req.body;
    if (index === undefined) return res.status(400).json({ message: 'index is required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL app.user = $1', [editedBy || 'unknown']);
      // If you want this to also be captured by the audit mechanism, write to "actuators"
      // For now, leaving your existing "cells" upsert as-is:
      await client.query(
        'INSERT INTO cells (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value',
        [index, value]
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

// Load all cells
app.get('/api/data', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cells');
    const data = {};
    for (const row of result.rows) data[row.id] = row.value;
    res.json(data);
  } catch (err) {
    console.error('Error fetching from DB:', err);
    res.status(500).json({ message: 'Error reading data' });
  }
});

app.get('/dbcheck', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('actuators','actuators_audit')
      ORDER BY table_name;
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
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

