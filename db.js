// db.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data.db');

// Create the table if it doesn't exist
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS cells (
            id TEXT PRIMARY KEY,
            value TEXT
        )
    `);
});

module.exports = db;
