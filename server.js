const express = require('express');
const path = require('path');
const cors = require('cors');
const { pool } = require('./db');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Save / update a cell
app.post('/api/save', async (req, res) => {
  try {
    const { index, value } = req.body;
    if (index === undefined) return res.status(400).json({ message: 'index is required' });

    const cellId = `cell${index}`;
    await pool.query(
      'INSERT INTO cells (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value',
      [cellId, value]
    );
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
