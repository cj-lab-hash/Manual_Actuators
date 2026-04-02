// server.js
require('dotenv').config();
console.log('✅ server.js loaded');

const express = require('express');
const path = require('path');
const cors = require('cors');
const { pool } = require('./db');

const app = express();

/* -------------------------------------------
   Middleware
--------------------------------------------*/
app.use(express.json({ limit: '10kb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Optional bearer token auth
const AUTH_TOKEN = process.env.AUTH_TOKEN;
if (AUTH_TOKEN) {
  app.use((req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (token !== AUTH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });
}

/* -------------------------------------------
   DB Schema Init (MUST FINISH BEFORE SERVER START)
--------------------------------------------*/
async function initDatabase() {
  console.log('✅ initDatabase() starting');

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
  DECLARE actor TEXT := current_setting('app.user', true);
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO actuators_audit(op, row_id, changed_by, new_data)
      VALUES ('INSERT', NEW.id, actor, NEW.data);
      RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
      INSERT INTO actuators_audit(op, row_id, changed_by, old_data, new_data)
      VALUES ('UPDATE', NEW.id, actor, OLD.data, NEW.data);
      RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO actuators_audit(op, row_id, changed_by, old_data)
      VALUES ('DELETE', OLD.id, actor, OLD.data);
      RETURN OLD;
    END IF;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_audit_actuators ON actuators;
  CREATE TRIGGER trg_audit_actuators
  AFTER INSERT OR UPDATE OR DELETE ON actuators
  FOR EACH ROW EXECUTE FUNCTION audit_actuators();

  CREATE TABLE IF NOT EXISTS cells (
    id TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS cells_audit (
    audit_id BIGSERIAL PRIMARY KEY,
    cell_id TEXT NOT NULL,
    op TEXT NOT NULL,
    changed_by TEXT,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
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
      RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
      INSERT INTO cells_audit(cell_id, op, changed_by, old_value, new_value)
      VALUES (NEW.id, 'UPDATE', actor, OLD.value, NEW.value);
      RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO cells_audit(cell_id, op, changed_by, old_value)
      VALUES (OLD.id, 'DELETE', actor, OLD.value);
      RETURN OLD;
    END IF;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_audit_cells ON cells;
  CREATE TRIGGER trg_audit_cells
  AFTER INSERT OR UPDATE OR DELETE ON cells
  FOR EACH ROW EXECUTE FUNCTION audit_cells_changes();
  `;

  await pool.query(schema);

  console.log('📦 Schema initialized (actuators + cells + audits)');
}

/* -------------------------------------------
   API Routes
--------------------------------------------*/
app.post('/api/save', async (req, res) => {
  const { value, editedBy, index } = req.body;
  const cellId = `cells#${Number(index)}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user', $1, true)`, [editedBy || 'unknown']);
    await client.query(
      `INSERT INTO cells (id, value)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
      [cellId, value]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/data', async (_req, res) => {
  const { rows } = await pool.query(`SELECT id, value FROM cells`);
  res.json(
    Object.fromEntries(rows.map(r => [r.id.replace('cells#', ''), r.value]))
  );
});
app.get('/_debug/dbinfo', async (_req, res) => {
  const db = await pool.query('SELECT current_database(), current_user');
  const path = await pool.query('SHOW search_path');
  res.json({
    database: db.rows[0].current_database,
    user: db.rows[0].current_user,
    search_path: path.rows[0].search_path
  });
});
/* -------------------------------------------
   Start server ONLY AFTER schema is ready
--------------------------------------------*/
const PORT = process.env.PORT || 10000;

(async () => {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('❌ Fatal startup error:', err);
    process.exit(1);
  }
})();
