require('dotenv').config();
const express   = require('express');
const path      = require('path');
const cors      = require('cors');
const nondbMode    = require('./backend/middleware/nondb-mode');
const { requireAuth } = require('./backend/middleware/auth');
const graphqlHandler  = require('./backend/graphql');

const app  = express();
const PORT = process.env.PORT || 9000;

app.use(cors());
app.use(express.json());
app.use(nondbMode);

// Block direct API Gateway hits that bypass CloudFront (cost + security protection)
if (process.env.ORIGIN_SECRET) {
    app.use((req, res, next) => {
        const pub = req.path === '/health' || req.path.startsWith('/api/site-config');
        if (!pub && req.headers['x-origin-secret'] !== process.env.ORIGIN_SECRET) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        next();
    });
}

// Set req.apiVersion from Accept header: application/json;v=1
app.use((req, res, next) => {
    const match    = (req.headers['accept'] || '').match(/application\/json;v=(\d+)/);
    req.apiVersion = match ? parseInt(match[1]) : 1;
    next();
});

app.use(express.static(path.join(__dirname, 'frontend'), { extensions: ['html'] }));

app.post('/graphql', requireAuth, graphqlHandler);

app.use('/api/auth',          require('./backend/routes/auth'));
app.use('/api/contact',       require('./backend/routes/contact'));
app.use('/api/tenants',       requireAuth, require('./backend/routes/tenants'));
app.use('/api/subscriptions', requireAuth, require('./backend/routes/subscriptions'));
app.use('/api/invoices',      requireAuth, require('./backend/routes/invoices'));
app.use('/api/enhancements',  requireAuth, require('./backend/routes/enhancements'));
app.use('/api/metrics',       requireAuth, require('./backend/routes/metrics'));

// ── Public site config (no secrets) ─────────────────────────────────────
const DEFAULT_GALLERY = [
    { src: 'images/gallery_precision.svg',  alt: 'Precision Analytics',    title: 'Precision Analytics',         desc: 'Accurate property valuations and market trend analysis' },
    { src: 'images/gallery_leads.svg',      alt: 'Sales Pipeline',         title: 'Optimised Sales Pipeline',    desc: 'Manage leads, track progress, and close deals efficiently' },
    { src: 'images/gallery_inventory.svg',  alt: 'Property Inventory',     title: 'Multi-Project Data Isolation',desc: 'Secure, organised data management for all your projects' },
    { src: 'images/slide-dashboard.svg',    alt: 'AmaraData Dashboard',    title: 'Unified Dashboard',           desc: 'All your KPIs, recent invoices, and monthly revenue — at a glance' },
];
function _parseGallery(raw) {
    if (!raw) return DEFAULT_GALLERY;
    try { return JSON.parse(raw); } catch { return DEFAULT_GALLERY; }
}

app.get('/api/site-config', (_, res) => {
    res.json({
        companyName:    process.env.COMPANY_NAME      || 'AmaraData',
        tagline:        process.env.COMPANY_TAGLINE   || 'We Elevate',
        contactEmail:   process.env.CONTACT_EMAIL     || 'info@amaradata.com',
        contactPhone:   process.env.CONTACT_PHONE     || '',
        contactAddress: process.env.CONTACT_ADDRESS   || '',
        supportEmail:   process.env.SUPPORT_EMAIL     || '',
        salesEmail:     process.env.SALES_EMAIL       || '',
        socialLinkedIn: process.env.SOCIAL_LINKEDIN   || '',
        socialInstagram:process.env.SOCIAL_INSTAGRAM  || '',
        copyrightYear:  process.env.COPYRIGHT_YEAR    || String(new Date().getFullYear()),
        galleryImages:  _parseGallery(process.env.GALLERY_IMAGES),
    });
});

app.get('/health', (_, res) => res.json({ ok: true, service: 'amaradata-platform', ts: new Date() }));

// Ensure all unmatched /api/* routes return JSON — never HTML
app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));

// Unhandled Express errors must also return JSON for API paths
app.use((err, req, res, _next) => {
    if (req.path.startsWith('/api') || req.path === '/graphql') {
        return res.status(500).json({ error: err.message || 'Internal server error' });
    }
    res.status(500).sendFile(path.join(__dirname, 'frontend', 'login.html'));
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'frontend', 'login.html')));

if (require.main === module) {
    app.listen(PORT, () => console.log(`AmaraData platform running on http://localhost:${PORT}`));
}

module.exports = app;
