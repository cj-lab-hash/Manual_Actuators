// server.js
const express = require('express');
const path = require('path');
const cors = require('cors');
const { pool } = require('./db');

/* -------------------------------------------
   DB Schema Init (runs on boot)
--------------------------------------------*/
async function initDatabase() {
  const schema = `
  /* ====== ACTUATORS + AUDIT ====== */
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

  /* ====== CELLS + AUDIT ====== */
  CREATE TABLE IF NOT EXISTS cells (
    id    TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS cells_audit (
    audit_id    BIGSERIAL PRIMARY KEY,
    cell_id     TEXT NOT NULL,
    op          TEXT NOT NULL,                 -- INSERT / UPDATE / DELETE
    changed_by  TEXT,                          -- from app.user (set in route)
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    old_value   TEXT,
    new_value   TEXT
  );

  CREATE OR REPLACE FUNCTION audit_cells_changes()
  RETURNS TRIGGER AS $$
  DECLARE
    actor TEXT := current_setting('app.user', true);
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO cells_audit(cell_id, op, changed_by, old_value, new_value)
      VALUES (NEW.id, 'INSERT', actor, NULL, NEW.value);
      RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
      INSERT INTO cells_audit(cell_id, op, changed_by, old_value, new_value)
      VALUES (NEW.id, 'UPDATE', actor, OLD.value, NEW.value);
      RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO cells_audit(cell_id, op, changed_by, old_value, new_value)
      VALUES (OLD.id, 'DELETE', actor, OLD.value, NULL);
      RETURN OLD;
    END IF;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_audit_cells ON cells;
  CREATE TRIGGER trg_audit_cells
  AFTER INSERT OR UPDATE OR DELETE ON cells
  FOR EACH ROW EXECUTE FUNCTION audit_cells_changes();

  CREATE INDEX IF NOT EXISTS idx_cells_audit_cell_id ON cells_audit (cell_id);
  CREATE INDEX IF NOT EXISTS idx_cells_audit_changed_at ON cells_audit (changed_at);
  `;

  try {
    await pool.query(schema);
    console.log('📦 Schema initialized (actuators + cells + audits).');
  } catch (err) {
    console.error('❌ Schema init error:', err);
  }
}
initDatabase();

/* -------------------------------------------
   App & Middleware
--------------------------------------------*/
const app = express();

// SECURITY: limit JSON payload to avoid accidental large posts
app.use(express.json({ limit: '10kb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Optional bearer token check if AUTH_TOKEN is set in env
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
   Core API
--------------------------------------------*/

// Save / update a cell in "cells" (audited by cells_audit)
app.post('/api/save', async (req, res) => {
  try {
    console.log('--- /api/save payload ---', req.body);
    const { value, editedBy } = req.body;

    // index can arrive as a string from the browser; normalize safely
    const idxNum = Number(req.body.index);
    if (!Number.isInteger(idxNum) || idxNum < 0) {
      return res.status(400).json({ error: 'index must be a non-negative integer' });
    }
    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'value must be a string' });
    }
    if (value.length > 5000) {
      return res.status(400).json({ error: 'value exceeds maximum length (5000 chars)' });
    }

    const cellId = `cells#${idxNum}`; // keep current storage format

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // per-request actor for triggers
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
    res.status(500).json({ error: 'Error saving data' });
  }
});

// Load all cells (normalize keys so the UI receives "0","1","2", ... instead of "cells#0"...)
app.get('/api/data', async (_req, res) => {
  try {
    const result = await pool.query('SELECT id, value FROM cells');
    const data = {};
    for (const row of result.rows) {
      const normalizedKey = String(row.id).startsWith('cells#')
        ? String(row.id).slice('cells#'.length)
        : String(row.id);
      data[normalizedKey] = row.value;
    }
    res.json(data);
  } catch (err) {
    console.error('Error fetching from DB:', err);
    res.status(500).json({ error: 'Error reading data' });
  }
});

/* -------------------------------------------
   Verify / Demo routes (optional)
--------------------------------------------*/

// Check that the two audit tables for actuators exist
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

// Demo insert into "actuators" (to see actuators audit working)
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

// Show latest audit entries from actuators_audit
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

// Inspect "cells" columns (sanity check)
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

/* -------------------------------------------
   NEW: cell-audit with decode (who/what/where)
--------------------------------------------*/

// Map "cells#<n>" to row & column names (4 columns total)
function decodeCellId(cellId) {
  const n = parseInt(String(cellId).replace(/^cells#/, ''), 10);
  if (Number.isNaN(n)) return null;
  const columns = ['NAME', 'DESCRIPTION', 'BARCODE', 'REMARKS'];
  const colIdx = n % columns.length;
  const rowIdx = Math.floor(n / columns.length);
  return { index: n, row: rowIdx, column: columns[colIdx] };
}

// View last N edits. Optional filters: ?actor=...&cell=cells#9
app.get('/api/cell-audit', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
  const { actor, cell } = req.query;

  // Parameterized WHERE to prevent injection
  const params = [];
  const whereClauses = [];
  if (actor) { params.push(actor); whereClauses.push(`changed_by = $${params.length}`); }
  if (cell)  { params.push(cell);  whereClauses.push(`cell_id = $${params.length}`); }
  params.push(limit);

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const sql = `
    SELECT audit_id, cell_id, op, changed_by, changed_at, old_value, new_value
    FROM cells_audit
    ${whereSql}
    ORDER BY changed_at DESC
    LIMIT $${params.length}
  `;

  try {
    const { rows } = await pool.query(sql, params);
    const enriched = rows.map(r => ({ ...r, ...decodeCellId(r.cell_id) }));
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* -------------------------------------------
   Start server & graceful shutdown
--------------------------------------------*/
const PORT = process.env.PORT || 3003;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

function shutdown() {
  console.log('Shutting down...');
  server.close(async () => {
    try { await pool.end(); } catch {}
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
