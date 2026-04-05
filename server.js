// server.js
require("dotenv").config();

const express = require("express");
const path = require("path");
const cors = require("cors");
const { pool } = require("./db");

pool.query("SHOW search_path;")
  .then(r => console.log("search_path =", r.rows[0].search_path))
  .catch(err => console.error("SHOW search_path failed:", err));
const app = express();
app.set("trust proxy", 1);

/* ===========================================
   Basic middleware
=========================================== */
app.use(express.json({ limit: "10kb" }));
app.use(cors());

// Simple request logger (helps debug why nothing is being called)
app.use((req, _res, next) => {
  if (req.path.startsWith("/api") || req.path === "/config.js") {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

/* ===========================================
   Inject AUTH_TOKEN into frontend
=========================================== */
app.get("/config.js", (_req, res) => {
  res.type("application/javascript");
  res.send(`window.AUTH_TOKEN = "${process.env.AUTH_TOKEN || ""}";`);
});

/* ===========================================
   Serve static frontend
=========================================== */
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

/* ===========================================
   Auth (protect write operations only)
=========================================== */
const AUTH_TOKEN = process.env.AUTH_TOKEN;

function getBearerToken(req) {
  const auth = req.headers["authorization"] || "";
  const parts = auth.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1];
  return null;
}

if (AUTH_TOKEN) {
  app.use((req, res, next) => {
    if (req.method === "GET") return next(); // read-only allowed
    const token = getBearerToken(req);
    if (token !== AUTH_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  });
}

/* ===========================================
   Database Schema Init
=========================================== */
async function initDatabase() {
  // Run each statement separately for reliability
  const statements = [
    `
    CREATE TABLE IF NOT EXISTS cells (
      id TEXT PRIMARY KEY,
      value TEXT
    );
    `,
    `
    CREATE TABLE IF NOT EXISTS cells_audit (
      audit_id BIGSERIAL PRIMARY KEY,
      cell_id TEXT NOT NULL,
      op TEXT NOT NULL,
      changed_by TEXT,
      changed_at TIMESTAMPTZ DEFAULT now(),
      old_value TEXT,
      new_value TEXT
    );
    `,
    `
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
    `,
    `
    DROP TRIGGER IF EXISTS trg_audit_cells ON cells;
    `,
    `
    CREATE TRIGGER trg_audit_cells
    AFTER INSERT OR UPDATE ON cells
    FOR EACH ROW EXECUTE FUNCTION audit_cells_changes();
    `,
  ];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const sql of statements) await client.query(sql);
    await client.query("COMMIT");
    console.log("✅ Database schema ready.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ initDatabase error:", err);
    throw err;
  } finally {
    client.release();
  }
}

/* ===========================================
   API Routes
=========================================== */

// Save or update a cell
app.post("/api/save", async (req, res) => {
  const { index, value, editedBy } = req.body;

  if (!Number.isInteger(index) || typeof value !== "string") {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const cellId = `cells#${index}`;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Set actor for audit trigger
    await client.query(`SELECT set_config('app.user', $1, true)`, [
      editedBy || "unknown",
    ]);

    await client.query(
      `
      INSERT INTO cells (id, value)
      VALUES ($1, $2)
      ON CONFLICT (id)
      DO UPDATE SET value = EXCLUDED.value
      `,
      [cellId, value]
    );

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ /api/save error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Load all cell data
app.get("/api/data", async (_req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT id, value
      FROM cells
      ORDER BY regexp_replace(id, '\\D', '', 'g')::int
    `);

    const data = {};
for (const r of rows) {
  const match = String(r.id).match(/\d+/);   // extracts "12" from "cell12" or "cells#12"
  if (!match) continue;
  const idx = match[0];
  data[idx] = r.value ?? '';
}
res.json(data);
  } catch (err) {
    console.error("❌ /api/data error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
// Delete a range of cells (used by remove row)
app.post("/api/deleteRange", async (req, res) => {
  const { startIndex, count, editedBy } = req.body;

  if (!Number.isInteger(startIndex) || !Number.isInteger(count) || count <= 0) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const ids = [];
  for (let i = 0; i < count; i++) {
    ids.push(`cells#${startIndex + i}`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.user', $1, true)`, [
      editedBy || "unknown",
    ]);

    await client.query(`DELETE FROM cells WHERE id = ANY($1::text[])`, [ids]);

    await client.query("COMMIT");
    res.json({ success: true, deleted: ids.length });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ /api/deleteRange error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
// Optional: quick debug endpoint to confirm DB connectivity
app.get("/api/debug/db", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT now() AS server_time");
    res.json({ ok: true, server_time: rows[0].server_time });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Health check
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

/* ===========================================
   SPA fallback (serves index.html for non-API routes)
   This ensures refresh doesn't 404 on Render.
=========================================== */
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(publicDir, "index.html"));
});

/* ===========================================
   Start Server
=========================================== */
const PORT = process.env.PORT || 10000;

(async () => {
  try {
    console.log("🚀 Starting application...");
    await initDatabase();
    app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
  } catch (err) {
    console.error("❌ Fatal startup error:", err);
    process.exit(1);
  }
})();