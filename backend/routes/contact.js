const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

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
    const fromEmail  = process.env.CONTACT_EMAIL || adminEmail;
    if (!adminEmail || !fromEmail) return;

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
        const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
        const ses = new SESClient({ region: process.env.AWS_REGION || 'ap-south-1' });
        await ses.send(new SendEmailCommand({
            Source: fromEmail,
            Destination: { ToAddresses: [adminEmail] },
            Message: {
                Subject: { Data: `[AmaraData] Contact: ${submission.ref_number}` },
                Body:    { Text: { Data: body } },
            },
        }));
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
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/contact  (admin — view all submissions)
router.get('/', requireAuth, async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const rows = req.db.fileDb.list('contact_submissions');
            return res.json({ success: true, data: rows.sort((a, b) => b.id - a.id) });
        }
        const { rows } = await db.query(
            `SELECT * FROM contact_submissions ORDER BY submitted_at DESC`
        );
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
