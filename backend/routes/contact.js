const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendEmail }   = require('../services/ses');

function makeRef() {
    const d   = new Date();
    const ymd = d.getFullYear().toString()
        + String(d.getMonth() + 1).padStart(2, '0')
        + String(d.getDate()).padStart(2, '0');
    const rnd = String(Math.floor(Math.random() * 9000) + 1000);
    return `REF-${ymd}-${rnd}`;
}

async function sendAdminEmail(submission) {
    const adminEmail = process.env.ADMIN_EMAIL || process.env.CONTACT_EMAIL;
    if (!adminEmail) return;

    const body = [
        `New contact submission received.`,
        ``,
        `Reference : ${submission.ref_number}`,
        `Name      : ${submission.name}`,
        `Email     : ${submission.email}`,
        `Phone     : ${submission.phone || '—'}`,
        `Company   : ${submission.company || '—'}`,
        ``,
        `Message:`,
        submission.message,
    ].join('\n');

    try {
        // Reuses services/ses.js's sendEmail() — same SES_FROM_EMAIL dev-mode
        // guard (logs to stdout instead of calling AWS) as every other email
        // in the app, e.g. auth.js's password-reset mail. contact.js used to
        // instantiate its own SESClient here, gated only on ADMIN_EMAIL/
        // CONTACT_EMAIL (both set in .env for real, non-test reasons) — so it
        // always attempted a real AWS call in local dev/tests, which failed
        // against .env's placeholder AWS credentials and made unrelated GET
        // /api/contact tests flaky (background SES retries delayed them past
        // Vitest's 5s timeout).
        await sendEmail({
            to:      adminEmail,
            subject: `[AmaraData] Contact: ${submission.ref_number}`,
            text:    body,
            html:    `<pre style="font-family:sans-serif;white-space:pre-wrap">${body.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`,
        });
    } catch (err) {
        // SES not configured or not verified — log and continue
        console.warn('Contact email not sent:', err.message);
    }
}

// POST /api/contact  (public — no auth required)
router.post('/', async (req, res) => {
    const { name, email, phone, company, message } = req.body;
    if (!name || !email || !message) {
        return res.status(400).json({ error: 'name, email and message are required' });
    }
    const ref_number   = makeRef();
    const submitted_at = new Date().toISOString();

    try {
        let row;
        if (req.db.mode === 'nondb') {
            row = req.db.fileDb.create('contact_submissions', {
                ref_number, name, email,
                phone: phone || null, company: company || null, message,
                status: 'new', submitted_at, updated_at: submitted_at,
            });
        } else {
            const { rows } = await db.query(
                `INSERT INTO contact_submissions
                 (ref_number,name,email,phone,company,message,status,submitted_at,updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,'new',NOW(),NOW()) RETURNING *`,
                [ref_number, name, email, phone || null, company || null, message]
            );
            row = rows[0];
        }

        // fire-and-forget email
        sendAdminEmail(row);

        res.status(201).json({ success: true, ref_number: row.ref_number });
    } catch (e) { console.error('[contact]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/contact  (admin — view all submissions)
router.get('/', requireAuth, async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const rows = req.db.fileDb.find('contact_submissions');
            return res.json({ success: true, data: rows.sort((a, b) => b.id - a.id) });
        }
        const { rows } = await db.query(
            `SELECT * FROM contact_submissions ORDER BY submitted_at DESC`
        );
        res.json({ success: true, data: rows });
    } catch (e) { console.error('[contact]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
