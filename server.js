'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8888;
const indexPath = path.join(__dirname, '/src/view/index.html');

app.use(express.static(path.join(__dirname, '/src/')));

// Set proper MIME types for WASM and JS files
app.use((req, res, next) => {
    if (req.url.endsWith('.wasm')) {
        res.setHeader('Content-Type', 'application/wasm');
    } else if (req.url.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript');
    }
    next();
});

// Serve index.html for root route
app.get('/', (req, res) => {
    res.sendFile(indexPath);
});

// Handle 404 errors
app.use((req, res) => {
    res.status(404).send('Not found');
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err.message);
    res.status(500).send('Internal Server Error');
});

app.listen(PORT, () => {
    console.log(`🎙️ RNNoise server running at http://localhost:${PORT}`);
});
