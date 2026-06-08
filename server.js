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

// ── Schema migrations — run once per cold start, block API requests until done ──
const _migrationReady = (() => {
    if (process.env.NONDB_MODE === 'true') return Promise.resolve();
    const _db = require('./backend/db');
    return (async () => {
        const steps = [
            `CREATE TABLE IF NOT EXISTS amr_roles (
                id SERIAL PRIMARY KEY, name VARCHAR(50) UNIQUE NOT NULL,
                label VARCHAR(100) NOT NULL, description TEXT,
                is_system BOOLEAN NOT NULL DEFAULT false,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP NOT NULL DEFAULT NOW())`,
            `INSERT INTO amr_roles (name,label,description,is_system) VALUES
                ('site_admin','Site Admin','Full platform access including user and role management',true),
                ('admin','Admin','Tenant, invoice and enhancement management',true),
                ('sales_manager','Sales Manager','View and manage tenant sales pipeline',true),
                ('billing','Billing','Access to invoices and payments',true),
                ('staff','Staff','Basic read-only platform access',true)
             ON CONFLICT (name) DO NOTHING`,
            `CREATE TABLE IF NOT EXISTS amr_user_groups (
                id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, description TEXT,
                role VARCHAR(50) REFERENCES amr_roles(name) ON DELETE SET NULL,
                is_active BOOLEAN NOT NULL DEFAULT true,
                created_by INTEGER REFERENCES amr_users(id),
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP NOT NULL DEFAULT NOW())`,
            `CREATE TABLE IF NOT EXISTS amr_user_group_members (
                id SERIAL PRIMARY KEY,
                group_id INTEGER NOT NULL REFERENCES amr_user_groups(id) ON DELETE CASCADE,
                user_id  INTEGER NOT NULL REFERENCES amr_users(id)  ON DELETE CASCADE,
                added_at TIMESTAMP NOT NULL DEFAULT NOW(),
                UNIQUE (group_id, user_id))`,
            `CREATE INDEX IF NOT EXISTS idx_ugm_group ON amr_user_group_members(group_id)`,
            `CREATE INDEX IF NOT EXISTS idx_ugm_user  ON amr_user_group_members(user_id)`,
        ];
        for (const sql of steps) {
            try { await _db.query(sql); }
            catch (e) { console.error('[migration]', e.message); }
        }
    })();
})();

// All API requests wait for migrations to complete before being handled
app.use('/api', (req, res, next) => { _migrationReady.then(next, next); });

app.use(express.static(path.join(__dirname, 'frontend'), { extensions: ['html'] }));

app.post('/graphql', requireAuth, graphqlHandler);

app.use('/api/auth',          require('./backend/routes/auth'));
app.use('/api/admin',         require('./backend/routes/admin'));
app.use('/api/contact',       require('./backend/routes/contact'));
app.use('/api/tenants',       requireAuth, require('./backend/routes/tenants'));
app.use('/api/subscriptions', requireAuth, require('./backend/routes/subscriptions'));
app.use('/api/invoices',      requireAuth, require('./backend/routes/invoices'));
app.use('/api/enhancements',  requireAuth, require('./backend/routes/enhancements'));
app.use('/api/metrics',       requireAuth, require('./backend/routes/metrics'));
app.use('/api/email',         requireAuth, require('./backend/routes/email'));

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

// Unhandled Express errors — log internally, never expose raw messages to client
app.use((err, req, res, _next) => {
    console.error('[express]', err.message);
    if (req.path.startsWith('/api') || req.path === '/graphql') {
        return res.status(500).json({ error: 'Internal server error' });
    }
    res.status(500).sendFile(path.join(__dirname, 'frontend', 'login.html'));
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'frontend', 'login.html')));

if (require.main === module) {
    app.listen(PORT, () => console.log(`AmaraData platform running on http://localhost:${PORT}`));
}

module.exports = app;
