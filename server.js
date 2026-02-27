// server.js or app.js
const express = require('express');
const path = require('path');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// POST /api/save - Save or update a cell
app.post('/api/save', (req, res) => {
    const { index, value } = req.body;
    const cellId = `cell${index}`;

    db.run(
        `INSERT INTO cells (id, value) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET value = excluded.value`,
        [cellId, value],
        function (err) {
            if (err) {
                console.error('Error saving to DB:', err);
                return res.status(500).json({ message: 'Error saving data' });
            }
            res.json({ message: 'Data saved successfully!' });
        }
    );
});

// GET /api/data - Load all cells
app.get('/api/data', (req, res) => {
    db.all(`SELECT * FROM cells`, [], (err, rows) => {
        if (err) {
            console.error('Error fetching from DB:', err);
            return res.status(500).json({ message: 'Error reading data' });
        }

        // Convert rows into JSON like { cell1: 'value1', cell2: 'value2' }
        const data = {};
        rows.forEach(row => {
            data[row.id] = row.value;
        });

        res.json(data);
    });
});

// Start the server
const PORT = 3003;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
