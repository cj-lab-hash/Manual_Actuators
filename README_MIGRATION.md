
# Migration to PostgreSQL on Render

This project has been reconfigured to store data in **PostgreSQL** instead of the previous local SQLite/JSON storage. The table `cells(id TEXT PRIMARY KEY, value TEXT)` is created automatically on startup.

## 1) Install dependencies

```bash
npm i pg
```

(You likely already have `express` and `cors`.)

## 2) Local development

Create `.env` with your **External** connection string from your Render Postgres database:

```env
DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/DBNAME?sslmode=require
```

Start the server:

```bash
PORT=3003 node server.js
```

## 3) Import existing data (optional)

If you have `data.json` in the project root and want to import it into Postgres:

```bash
node scripts/import-data.js
```

## 4) Deploy on Render

1. Create a **PostgreSQL** database in Render (same region as your web service).
2. In your **Web Service → Environment**, set `DATABASE_URL` to the **Internal** connection string from the database page (keep `sslmode=require`).
3. Redeploy your service. The table is created automatically. (Optionally, add a post-deploy command: `node scripts/import-data.js` to seed data once.)
4. Keep connection pools small (default here is 5) to avoid `too many connections`.

## Notes
- Files written to the app directory are **ephemeral** on Render and disappear on redeploy. Use the database for durable data.
- If you scale to multiple instances, the effective number of DB connections is `instances × pool size`.
