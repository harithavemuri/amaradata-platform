require('dotenv').config();
const express = require('express');
const path    = require('path');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 9000;

app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'frontend')));

// API routes
app.use('/api/auth',          require('./backend/routes/auth'));
app.use('/api/tenants',       require('./backend/routes/tenants'));
app.use('/api/subscriptions', require('./backend/routes/subscriptions'));
app.use('/api/invoices',      require('./backend/routes/invoices'));
app.use('/api/enhancements',  require('./backend/routes/enhancements'));
app.use('/api/metrics',       require('./backend/routes/metrics'));

// Health check
app.get('/health', (_, res) => res.json({ ok: true, service: 'amaradata-platform', ts: new Date() }));

// SPA fallback — serve login for unknown routes
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'frontend', 'login.html')));

app.listen(PORT, () => console.log(`AmaraData platform running on http://localhost:${PORT}`));
