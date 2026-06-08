const router = require('express').Router();
const { requireAdmin } = require('../middleware/auth');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const EMAIL_REGION = 'us-east-1';
const s3  = new S3Client({ region: EMAIL_REGION });
const ses = new SESClient({ region: EMAIL_REGION });

const BUCKET = process.env.EMAIL_BUCKET;
const FROM   = process.env.EMAIL_INBOX_FROM || 'rajas@amaradata.com';
const PREFIX = 'emails/';

async function toBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function getRaw(id) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}${id}` }));
    return toBuffer(obj.Body);
}

async function buildMime(mailOptions) {
    return new Promise((resolve, reject) => {
        const t = nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true });
        t.sendMail(mailOptions, (err, info) => err ? reject(err) : resolve(info.message));
    });
}

// GET /api/email/inbox
router.get('/inbox', requireAdmin, async (req, res) => {
    if (!BUCKET) return res.status(503).json({ error: 'EMAIL_BUCKET not configured' });
    try {
        const list    = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX }));
        const objects = (list.Contents || []).sort((a, b) => b.LastModified - a.LastModified);

        const emails = await Promise.all(objects.map(async (obj) => {
            const id = obj.Key.replace(PREFIX, '');
            try {
                const raw    = await getRaw(id);
                const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
                return {
                    id,
                    from:           parsed.from?.text || '',
                    to:             parsed.to?.text   || '',
                    subject:        parsed.subject    || '(no subject)',
                    date:           parsed.date       || obj.LastModified,
                    hasAttachments: (parsed.attachments || []).length > 0,
                };
            } catch {
                return { id, from: '', subject: '(parse error)', date: obj.LastModified, hasAttachments: false };
            }
        }));

        res.json({ success: true, data: emails });
    } catch (e) { console.error('[email]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/email/:id
router.get('/:id', requireAdmin, async (req, res) => {
    if (!BUCKET) return res.status(503).json({ error: 'EMAIL_BUCKET not configured' });
    try {
        const raw    = await getRaw(req.params.id);
        const parsed = await simpleParser(raw);
        res.json({ success: true, data: {
            id:          req.params.id,
            from:        parsed.from?.text       || '',
            to:          parsed.to?.text         || '',
            cc:          parsed.cc?.text         || '',
            subject:     parsed.subject          || '(no subject)',
            date:        parsed.date,
            text:        parsed.text             || '',
            html:        parsed.html             || '',
            messageId:   parsed.messageId        || '',
            replyTo:     parsed.replyTo?.text    || parsed.from?.text || '',
            attachments: (parsed.attachments || []).map((a, i) => ({
                index:       i,
                filename:    a.filename    || `attachment-${i}`,
                contentType: a.contentType || 'application/octet-stream',
                size:        a.size        || a.content?.length || 0,
            })),
        }});
    } catch (e) { console.error('[email]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/email/:id/attachment/:index
router.get('/:id/attachment/:index', requireAdmin, async (req, res) => {
    if (!BUCKET) return res.status(503).json({ error: 'EMAIL_BUCKET not configured' });
    try {
        const raw    = await getRaw(req.params.id);
        const parsed = await simpleParser(raw);
        const att    = (parsed.attachments || [])[parseInt(req.params.index, 10)];
        if (!att) return res.status(404).json({ error: 'Attachment not found' });
        res.setHeader('Content-Type', att.contentType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(att.filename || 'attachment')}"`);
        res.send(att.content);
    } catch (e) { console.error('[email]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/email/send
router.post('/send', requireAdmin, async (req, res) => {
    const { to, cc, subject, text, html, attachments = [] } = req.body;
    if (!to || !subject) return res.status(400).json({ error: 'to and subject are required' });
    try {
        const raw = await buildMime({
            from:        FROM,
            to,
            cc:          cc || undefined,
            subject,
            text:        text || '',
            html:        html || undefined,
            attachments: attachments.map(a => ({
                filename:    a.filename,
                content:     Buffer.from(a.content, 'base64'),
                contentType: a.contentType || 'application/octet-stream',
            })),
        });
        await ses.send(new SendRawEmailCommand({
            Source:       FROM,
            Destinations: [to, ...(cc ? [cc] : [])],
            RawMessage:   { Data: raw },
        }));
        res.json({ success: true });
    } catch (e) { console.error('[email]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/email/:id/reply
router.post('/:id/reply', requireAdmin, async (req, res) => {
    const { text, html, attachments = [] } = req.body;
    if (!text && !html) return res.status(400).json({ error: 'text or html required' });
    if (!BUCKET) return res.status(503).json({ error: 'EMAIL_BUCKET not configured' });
    try {
        const raw    = await getRaw(req.params.id);
        const parsed = await simpleParser(raw);
        const replyTo  = parsed.replyTo?.text || parsed.from?.text || '';
        const subject  = (parsed.subject || '').startsWith('Re:') ? parsed.subject : `Re: ${parsed.subject || ''}`;

        const mimeRaw = await buildMime({
            from:        FROM,
            to:          replyTo,
            subject,
            text:        text || '',
            html:        html || undefined,
            inReplyTo:   parsed.messageId,
            references:  [parsed.references, parsed.messageId].filter(Boolean).flat().join(' '),
            attachments: attachments.map(a => ({
                filename:    a.filename,
                content:     Buffer.from(a.content, 'base64'),
                contentType: a.contentType || 'application/octet-stream',
            })),
        });
        await ses.send(new SendRawEmailCommand({
            Source:       FROM,
            Destinations: [replyTo],
            RawMessage:   { Data: mimeRaw },
        }));
        res.json({ success: true });
    } catch (e) { console.error('[email]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
