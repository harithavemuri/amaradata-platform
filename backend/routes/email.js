const router = require('express').Router();
const { requireAdmin } = require('../middleware/auth');
const { s3, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = require('../services/email-s3-client');
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
// archiver@8 dropped the classic archiver('zip', opts) factory function in
// favor of exporting the format classes directly.
const { ZipArchive } = require('archiver');
const db = require('../db');

const EMAIL_REGION = 'us-east-1';
const ses = new SESClient({ region: EMAIL_REGION });

const BUCKET = process.env.EMAIL_BUCKET;
const FROM   = process.env.EMAIL_INBOX_FROM || 'rajas@amaradata.com';
const PREFIX = 'emails/';

// Same convention as services/ses.js: without SES_FROM_EMAIL (local dev/tests),
// log instead of making a real AWS SES call. Send/reply previously had no such
// guard — every call attempted a live SES send regardless of environment,
// the same gap contact.js's sendAdminEmail() had before it was fixed.
const SES_DEV_MODE = !process.env.SES_FROM_EMAIL;

async function sendRaw(raw, destinations) {
    if (SES_DEV_MODE) {
        console.log(`[email:dev] To: ${destinations.join(', ')}\n${raw.toString('utf8').slice(0, 500)}`);
        return;
    }
    await ses.send(new SendRawEmailCommand({ Source: FROM, Destinations: destinations, RawMessage: { Data: raw } }));
}

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

// ── Per-user folders ─────────────────────────────────────────────────────────
// Emails live in S3, not the DB — email_placements maps (user, email S3 key) to
// a folder. No row for a given (user, email) means that user sees it in Inbox;
// this is deliberate (avoids needing to backfill a placement row for every
// email that ever arrives) — Inbox is the *absence* of an explicit placement,
// not a real folder row. Trash is a real per-user folder row (is_trash=true),
// created lazily on first use rather than seeded for every user up front.

async function listFolders(req, userId) {
    if (req.db.mode === 'nondb') {
        return req.db.fileDb.find('email_folders').filter(f => f.user_id == userId);
    }
    const { rows } = await db.query('SELECT * FROM email_folders WHERE user_id=$1 ORDER BY is_trash, name', [userId]);
    return rows;
}

async function getOrCreateTrash(req, userId) {
    const folders = await listFolders(req, userId);
    const existing = folders.find(f => f.is_trash);
    if (existing) return existing;

    if (req.db.mode === 'nondb') {
        return req.db.fileDb.create('email_folders', { user_id: userId, name: 'Trash', is_trash: true });
    }
    const { rows } = await db.query(
        `INSERT INTO email_folders (user_id, name, is_trash) VALUES ($1,'Trash',true) RETURNING *`,
        [userId]
    );
    return rows[0];
}

async function getPlacement(req, userId, emailId) {
    if (req.db.mode === 'nondb') {
        return req.db.fileDb.find('email_placements').find(p => p.user_id == userId && p.email_id === emailId) || null;
    }
    const { rows } = await db.query('SELECT * FROM email_placements WHERE user_id=$1 AND email_id=$2', [userId, emailId]);
    return rows[0] || null;
}

// folderId === null moves the email back to Inbox (removes the placement row).
async function setPlacement(req, userId, emailId, folderId) {
    if (req.db.mode === 'nondb') {
        const existing = req.db.fileDb.find('email_placements').find(p => p.user_id == userId && p.email_id === emailId);
        if (folderId === null) {
            if (existing) req.db.fileDb.delete('email_placements', existing.id);
            return;
        }
        if (existing) req.db.fileDb.update('email_placements', existing.id, { folder_id: folderId });
        else req.db.fileDb.create('email_placements', { user_id: userId, email_id: emailId, folder_id: folderId });
        return;
    }
    if (folderId === null) {
        await db.query('DELETE FROM email_placements WHERE user_id=$1 AND email_id=$2', [userId, emailId]);
        return;
    }
    await db.query(
        `INSERT INTO email_placements (user_id, email_id, folder_id) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, email_id) DO UPDATE SET folder_id=EXCLUDED.folder_id, updated_at=NOW()`,
        [userId, emailId, folderId]
    );
}

// GET /api/email/folders — current user's custom folders + Trash (Inbox is implicit, not listed)
router.get('/folders', requireAdmin, async (req, res) => {
    try {
        const folders = await listFolders(req, req.staff.id);
        res.json({ success: true, data: folders });
    } catch (e) { console.error('[email]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/email/folders  { name }
router.post('/folders', requireAdmin, async (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
        if (req.db.mode === 'nondb') {
            const dup = req.db.fileDb.find('email_folders')
                .find(f => f.user_id == req.staff.id && f.name.toLowerCase() === name.toLowerCase());
            if (dup) return res.status(409).json({ error: 'A folder with that name already exists' });
            const row = req.db.fileDb.create('email_folders', { user_id: req.staff.id, name, is_trash: false });
            return res.status(201).json({ success: true, data: row });
        }
        const { rows } = await db.query(
            `INSERT INTO email_folders (user_id, name) VALUES ($1,$2) RETURNING *`,
            [req.staff.id, name]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'A folder with that name already exists' });
        console.error('[email]', e.message); res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/email/folders/:id — deletes the folder; emails inside revert to Inbox
router.delete('/folders/:id', requireAdmin, async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const folder = req.db.fileDb.getById('email_folders', req.params.id);
            if (!folder || folder.user_id != req.staff.id) return res.status(404).json({ error: 'Not found' });
            if (folder.is_trash) return res.status(400).json({ error: 'Cannot delete the Trash folder' });
            req.db.fileDb.find('email_placements')
                .filter(p => p.folder_id == folder.id)
                .forEach(p => req.db.fileDb.delete('email_placements', p.id));
            req.db.fileDb.delete('email_folders', folder.id);
            return res.json({ success: true });
        }
        const { rows } = await db.query('SELECT * FROM email_folders WHERE id=$1 AND user_id=$2', [req.params.id, req.staff.id]);
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        if (rows[0].is_trash) return res.status(400).json({ error: 'Cannot delete the Trash folder' });
        // email_placements.folder_id has ON DELETE SET NULL — emails revert to Inbox automatically.
        await db.query('DELETE FROM email_folders WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { console.error('[email]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/email/thread/download?ids=a,b,c — zip of selected emails' raw .eml
// content. Registered before the /:id/... routes below: without this, Express
// would match "/thread/download" against "/:id/download" (id="thread").
router.get('/thread/download', requireAdmin, async (req, res) => {
    if (!BUCKET) return res.status(503).json({ error: 'EMAIL_BUCKET not configured' });
    const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    try {
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="email-thread.zip"');
        const archive = new ZipArchive({ zlib: { level: 9 } });
        archive.on('error', (err) => { console.error('[email] zip error', err.message); if (!res.headersSent) res.status(500).end(); });
        archive.pipe(res);
        for (const id of ids) {
            try {
                const raw = await getRaw(id);
                archive.append(raw, { name: `${id}.eml` });
            } catch (e) { console.error(`[email] skipping ${id} in zip:`, e.message); }
        }
        await archive.finalize();
    } catch (e) {
        console.error('[email]', e.message);
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/email/inbox?folder=inbox|trash|<folderId>
router.get('/inbox', requireAdmin, async (req, res) => {
    if (!BUCKET) return res.status(503).json({ error: 'EMAIL_BUCKET not configured' });
    try {
        const folderParam = req.query.folder || 'inbox';
        let targetFolderId = null;

        if (folderParam === 'trash') {
            targetFolderId = (await getOrCreateTrash(req, req.staff.id)).id;
        } else if (folderParam !== 'inbox') {
            const folders = await listFolders(req, req.staff.id);
            const folder = folders.find(f => String(f.id) === String(folderParam));
            if (!folder) return res.status(404).json({ error: 'Folder not found' });
            targetFolderId = folder.id;
        }

        const list    = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX }));
        const objects = (list.Contents || []).sort((a, b) => b.LastModified - a.LastModified);

        const placements = req.db.mode === 'nondb'
            ? req.db.fileDb.find('email_placements').filter(p => p.user_id == req.staff.id)
            : (await db.query('SELECT * FROM email_placements WHERE user_id=$1', [req.staff.id])).rows;
        const placementByEmail = new Map(placements.map(p => [p.email_id, p]));

        const filtered = objects.filter((obj) => {
            const id = obj.Key.replace(PREFIX, '');
            const placement = placementByEmail.get(id);
            const folderId = placement ? placement.folder_id : null;
            if (folderParam === 'inbox') return folderId == null;
            return folderId != null && String(folderId) === String(targetFolderId);
        });

        const emails = await Promise.all(filtered.map(async (obj) => {
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

// GET /api/email/:id/download — the raw .eml file for a single email
router.get('/:id/download', requireAdmin, async (req, res) => {
    if (!BUCKET) return res.status(503).json({ error: 'EMAIL_BUCKET not configured' });
    try {
        const raw = await getRaw(req.params.id);
        res.setHeader('Content-Type', 'message/rfc822');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(req.params.id)}.eml"`);
        res.send(raw);
    } catch (e) { console.error('[email]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/email/:id/thread — related email ids in the same reply chain, found
// by walking Message-ID/In-Reply-To/References transitively across the whole
// inbox. O(n) scan over all S3 objects — fine at the scale a small admin inbox
// operates at; would need indexing if that ever stops being true.
router.get('/:id/thread', requireAdmin, async (req, res) => {
    if (!BUCKET) return res.status(503).json({ error: 'EMAIL_BUCKET not configured' });
    try {
        const list    = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX }));
        const objects = list.Contents || [];

        const parsedAll = await Promise.all(objects.map(async (obj) => {
            const id = obj.Key.replace(PREFIX, '');
            try {
                const raw    = await getRaw(id);
                const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
                return {
                    id,
                    messageId:  parsed.messageId  || null,
                    inReplyTo:  parsed.inReplyTo   || null,
                    references: parsed.references  || null,
                    subject:    parsed.subject     || '(no subject)',
                    date:       parsed.date        || obj.LastModified,
                };
            } catch { return null; }
        }));
        const valid  = parsedAll.filter(Boolean);
        const target = valid.find(e => e.id === req.params.id);
        if (!target) return res.status(404).json({ error: 'Not found' });

        const refsOf = (e) => {
            const refs = new Set();
            if (e.inReplyTo) refs.add(e.inReplyTo);
            if (Array.isArray(e.references)) e.references.forEach(r => refs.add(r));
            else if (typeof e.references === 'string') e.references.split(/\s+/).filter(Boolean).forEach(r => refs.add(r));
            return refs;
        };
        const byMessageId = new Map(valid.filter(e => e.messageId).map(e => [e.messageId, e]));

        const threadIds = new Set([target.id]);
        let frontier = [target];
        while (frontier.length) {
            const next = [];
            for (const e of frontier) {
                for (const ref of refsOf(e)) {
                    const ancestor = byMessageId.get(ref);
                    if (ancestor && !threadIds.has(ancestor.id)) { threadIds.add(ancestor.id); next.push(ancestor); }
                }
                for (const other of valid) {
                    if (threadIds.has(other.id)) continue;
                    if (e.messageId && refsOf(other).has(e.messageId)) { threadIds.add(other.id); next.push(other); }
                }
            }
            frontier = next;
        }

        const thread = valid
            .filter(e => threadIds.has(e.id))
            .sort((a, b) => new Date(a.date) - new Date(b.date))
            .map(e => ({ id: e.id, subject: e.subject, date: e.date }));

        res.json({ success: true, data: thread });
    } catch (e) { console.error('[email]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/email/:id/move  { folder_id: null|<id> } — null moves back to Inbox
router.put('/:id/move', requireAdmin, async (req, res) => {
    const folderId = req.body.folder_id ?? null;
    try {
        if (folderId !== null) {
            const folders = await listFolders(req, req.staff.id);
            if (!folders.find(f => String(f.id) === String(folderId))) {
                return res.status(404).json({ error: 'Folder not found' });
            }
        }
        await setPlacement(req, req.staff.id, req.params.id, folderId);
        res.json({ success: true });
    } catch (e) { console.error('[email]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/email/:id — move to Trash (recoverable via PUT .../move)
router.delete('/:id', requireAdmin, async (req, res) => {
    try {
        const trash = await getOrCreateTrash(req, req.staff.id);
        await setPlacement(req, req.staff.id, req.params.id, trash.id);
        res.json({ success: true });
    } catch (e) { console.error('[email]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/email/:id/permanent — actually deletes the S3 object. Requires
// the email to currently be in the caller's Trash first, matching "permanent
// delete is a separate, deliberate action" — not reachable directly from Inbox.
router.delete('/:id/permanent', requireAdmin, async (req, res) => {
    if (!BUCKET) return res.status(503).json({ error: 'EMAIL_BUCKET not configured' });
    try {
        const trash     = await getOrCreateTrash(req, req.staff.id);
        const placement = await getPlacement(req, req.staff.id, req.params.id);
        if (!placement || String(placement.folder_id) !== String(trash.id)) {
            return res.status(400).json({ error: 'Move the email to Trash before permanently deleting it' });
        }
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}${req.params.id}` }));
        // The S3 object is genuinely gone — clean up placement rows for every
        // user that had one, not just the caller.
        if (req.db.mode === 'nondb') {
            req.db.fileDb.find('email_placements')
                .filter(p => p.email_id === req.params.id)
                .forEach(p => req.db.fileDb.delete('email_placements', p.id));
        } else {
            await db.query('DELETE FROM email_placements WHERE email_id=$1', [req.params.id]);
        }
        res.json({ success: true });
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
        await sendRaw(raw, [to, ...(cc ? [cc] : [])]);
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
        await sendRaw(mimeRaw, [replyTo]);
        res.json({ success: true });
    } catch (e) { console.error('[email]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
