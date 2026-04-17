// server.js
require("dotenv").config();

const express = require("express");
const path = require("path");
const cors = require("cors");
const { pool } = require("./db");

const app = express();
app.set("trust proxy", 1);

/* ===========================================
   Basic middleware
=========================================== */
app.use(express.json({ limit: "10kb" }));
app.use(cors());

// Simple request logger
app.use((req, _res, next) => {
  if (req.path.startsWith("/api")) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

/* ===========================================
   Tokens
=========================================== */
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

/* ===========================================
   Helpers
=========================================== */
function getBearerToken(req) {
  const auth = req.headers["authorization"] || "";
  const parts = auth.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1];
  return null;
}

function requireAuth(req, res, next) {
 //  Only protect write routes (non-GET)
  if (req.method === "GET") return next();

  const token = getBearerToken(req);
 if (!AUTH_TOKEN || token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
 }
  next();
}
function requireAdmin(req, res, next) {
  const token = getBearerToken(req);
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

async function getEditor(name) {
  const { rows } = await pool.query(
    `SELECT name, role, active
     FROM manual_actuators.editors
     WHERE name = $1`,
    [name]
  );
  return rows[0] || null;
}

async function requireAllowedEditor(req, res, next) {
  const editedBy = req.body?.editedBy;

  if (!editedBy || typeof editedBy !== "string" || !editedBy.trim()) {
    return res.status(400).json({ error: "editedBy is required" });
  }

  try {
    const editor = await getEditor(editedBy.trim());
    if (!editor || !editor.active) {
      return res.status(403).json({ error: "Editor not allowed" });
    }
    req.editor = editor;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Editor check failed" });
  }
}
    //=== Optional middleware to enforce editedBy presence and store it in req for later use ===
    function requireEditedBy(req, res, next) {
      const editedBy = req.body?.editedBy;

      if (!editedBy || typeof editedBy !== "string" || !editedBy.trim()) {
        return res.status(400).json({ error: "editedBy is required" });
      }

      // normalize and store for later use
      req.editedBy = editedBy.trim();
      next();
    }
/* ===========================================
   Serve static frontend
=========================================== */
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

/* ===========================================
   IMPORTANT:
   Apply AUTH middleware AFTER static so index loads,
   but BEFORE write API routes.
   Also: Admin routes are handled separately and should not be blocked by AUTH.
=========================================== */

// Admin routes should NOT be blocked by AUTH middleware.
// We'll enforce admin routes with requireAdmin instead.
//((req, res, next) => {
//  if (!AUTH_TOKEN) return next();
//  if (req.method === "GET") return next();

  // Allow admin endpoints to pass through to requireAdmin
//  if (req.path.startsWith("/api/editors")) return next();

  // Otherwise require normal AUTH_TOKEN
//  return requireAuth(req, res, next);
//});

/* ===========================================
   Database Schema Init (optional/keep)
=========================================== */
async function initDatabase() {
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
    `DROP TRIGGER IF EXISTS trg_audit_cells ON cells;`,
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
//app.post("/api/save", requireAllowedEditor, async (req, res) => {
  app.post("/api/save", requireEditedBy, async (req, res) => {
  const { index, value, editedBy } = req.body;

  if (!Number.isInteger(index) || typeof value !== "string") {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const cellId = `cells#${index}`;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.user', $1, true)`, [editedBy.trim()]);

    await client.query(
      `
      INSERT INTO manual_actuators.cells (id, value)
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
      FROM manual_actuators.cells
      ORDER BY regexp_replace(id, '\\D', '', 'g')::int
    `);

    const data = {};
    for (const r of rows) {
      const match = String(r.id).match(/\d+/);
      if (!match) continue;
      data[match[0]] = r.value ?? "";
    }

    res.json(data);
  } catch (err) {
    console.error("❌ /api/data error:", err);
    res.status(500).json({ error: "Failed to load data" });
  } finally {
    client.release();
  }
});
// Example of a new API route to save an item 
  async function saveNewItemToServer(payload, token) {
  const res = await fetch("/api/items", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || "Server error");
  }

  return res.json();
}

// Delete a range of cells
app.post("/api/deleteRange", requireAuth ,requireAllowedEditor, async (req, res) => {
  const { startIndex, count, editedBy } = req.body;

  if (!Number.isInteger(startIndex) || !Number.isInteger(count) || count <= 0) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const ids = Array.from({ length: count }, (_, i) => `cells#${startIndex + i}`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.user', $1, true)`, [editedBy.trim()]);

    await client.query(`DELETE FROM manual_actuators.cells WHERE id = ANY($1::text[])`, [ids]);

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

// Editors list (public read)
app.get("/api/editors", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT name, role, active, created_at
       FROM manual_actuators.editors
       ORDER BY name`
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ /api/editors error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Add/update editor (admin only)
app.post("/api/editors", requireAdmin, async (req, res) => {
  const { name, role = "editor", active = true } = req.body || {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    await pool.query(
      `INSERT INTO manual_actuators.editors(name, role, active)
       VALUES ($1, $2, $3)
       ON CONFLICT (name)
       DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active`,
      [name.trim(), role, !!active]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ /api/editors POST error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Disable editor (admin only)
app.post("/api/editors/disable", requireAdmin, async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    await pool.query(
      `UPDATE manual_actuators.editors
       SET active = false
       WHERE name = $1`,
      [name.trim()]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ /api/editors/disable error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

/* ===========================================
   SPA fallback
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

    // Optional debug: remove after confirming
    const r = await pool.query("SHOW search_path;");
    console.log("search_path =", r.rows[0].search_path);

    app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
  } catch (err) {
    console.error("❌ Fatal startup error:", err);
    process.exit(1);
  }
})();
