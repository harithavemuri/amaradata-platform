// @vitest-environment node
//
// email.js always talks to real S3 for inbox/get/attachment (no dev-mode
// equivalent to services/ses.js's SES_FROM_EMAIL guard), so those calls are
// stubbed here. /send and /:id/reply now go through sendRaw() (see
// backend/routes/email.js), which no-ops instead of calling SES when
// SES_FROM_EMAIL is unset — true in this test env (src/test/setup.js never
// sets it) — so those routes are safe to exercise for real, no SES stub needed.
//
// vi.mock() doesn't reliably intercept require('../services/email-s3-client')
// nested inside server.js's CJS require graph (confirmed: the mock factory
// simply never runs). A plain ESM `import { s3 } from '...'` of the same file
// didn't work either — it resolves through a separate vite-node ESM/CJS
// interop path from server.js's own internal require() chain, landing on a
// different object instance. createRequire(import.meta.url) is the same
// pattern setup.js's afterAll already uses to reach the exact db.js pool
// instance a test file's own code used — it goes through Node's singular CJS
// require.cache, guaranteeing the same object email.js's require() sees.
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Readable }      from 'stream';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const emailS3   = _require('../../backend/services/email-s3-client.js');
const s3Send    = vi.fn();
emailS3.s3.send = s3Send;

import request from 'supertest';
import app from '../../server.js';
import { auth, assertJson } from './helpers.js';

const PLAIN_EMAIL = [
    'From: Alice <alice@example.com>',
    'To: rajas@amaradata.com',
    'Subject: Hello',
    'Date: Mon, 1 Jun 2026 10:00:00 +0000',
    'Content-Type: text/plain',
    '',
    'Hi there',
    '',
].join('\r\n');

const ATTACHMENT_EMAIL = [
    'From: Bob <bob@example.com>',
    'To: rajas@amaradata.com',
    'Subject: With Attachment',
    'Date: Tue, 2 Jun 2026 10:00:00 +0000',
    'Content-Type: multipart/mixed; boundary="BOUNDARY123"',
    '',
    '--BOUNDARY123',
    'Content-Type: text/plain',
    '',
    'Please see attached.',
    '',
    '--BOUNDARY123',
    'Content-Type: text/plain; name="note.txt"',
    'Content-Disposition: attachment; filename="note.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    'SGVsbG8gV29ybGQ=',
    '',
    '--BOUNDARY123--',
    '',
].join('\r\n');

function s3ObjectFor(id) {
    const raw = id === 'email-2' ? ATTACHMENT_EMAIL : PLAIN_EMAIL;
    return { Body: Readable.from([Buffer.from(raw)]) };
}

beforeAll(() => {
    s3Send.mockImplementation(async (cmd) => {
        const name = cmd.constructor.name;
        if (name === 'ListObjectsV2Command') {
            return {
                Contents: [
                    { Key: 'emails/email-1', LastModified: new Date('2026-06-01T10:00:00Z') },
                    { Key: 'emails/email-2', LastModified: new Date('2026-06-02T10:00:00Z') },
                ],
            };
        }
        if (name === 'GetObjectCommand') {
            const id = cmd.input.Key.replace('emails/', '');
            if (id === 'missing') throw new Error('NoSuchKey');
            return s3ObjectFor(id);
        }
        if (name === 'DeleteObjectCommand') {
            return {};
        }
        throw new Error(`unmocked S3 command: ${name}`);
    });
});

describe('Email routes (admin only)', () => {
    // ── GET /api/email/inbox ─────────────────────────────────────────────────
    describe('GET /api/email/inbox', () => {
        it('without auth → 401', async () => {
            const res = await request(app).get('/api/email/inbox');
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('with staff role → 403', async () => {
            const res = await request(app).get('/api/email/inbox').set(auth('staff'));
            assertJson(res);
            expect(res.status).toBe(403);
        });

        it('with admin → 200, parsed and sorted newest first', async () => {
            const res = await request(app).get('/api/email/inbox').set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toHaveLength(2);
            // email-2 (Jun 2) is newer than email-1 (Jun 1)
            expect(res.body.data[0].id).toBe('email-2');
            expect(res.body.data[0].subject).toBe('With Attachment');
            expect(res.body.data[0].hasAttachments).toBe(true);
            expect(res.body.data[1].id).toBe('email-1');
            expect(res.body.data[1].subject).toBe('Hello');
            expect(res.body.data[1].hasAttachments).toBe(false);
        });
    });

    // ── GET /api/email/:id ────────────────────────────────────────────────────
    describe('GET /api/email/:id', () => {
        it('without auth → 401', async () => {
            const res = await request(app).get('/api/email/email-1');
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('with admin → 200, full parsed detail', async () => {
            const res = await request(app).get('/api/email/email-1').set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.data.subject).toBe('Hello');
            expect(res.body.data.from).toContain('alice@example.com');
            expect(res.body.data.text.trim()).toBe('Hi there');
            expect(res.body.data.attachments).toHaveLength(0);
        });

        it('email with an attachment → attachments array populated', async () => {
            const res = await request(app).get('/api/email/email-2').set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.data.attachments).toHaveLength(1);
            expect(res.body.data.attachments[0].filename).toBe('note.txt');
        });

        it('S3 error (e.g. missing object) → 500, generic error body', async () => {
            const res = await request(app).get('/api/email/missing').set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(500);
            expect(res.body.error).not.toMatch(/NoSuchKey/); // raw AWS error never reaches the client
        });
    });

    // ── GET /api/email/:id/attachment/:index ─────────────────────────────────
    describe('GET /api/email/:id/attachment/:index', () => {
        it('without auth → 401', async () => {
            const res = await request(app).get('/api/email/email-2/attachment/0');
            expect(res.status).toBe(401);
        });

        it('valid index → 200 with the file content and headers', async () => {
            const res = await request(app).get('/api/email/email-2/attachment/0').set(auth('admin'));
            expect(res.status).toBe(200);
            expect(res.headers['content-disposition']).toContain('note.txt');
            expect(res.text).toBe('Hello World');
        });

        it('index out of range → 404', async () => {
            const res = await request(app).get('/api/email/email-2/attachment/9').set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(404);
        });

        it('email with no attachments, index 0 → 404', async () => {
            const res = await request(app).get('/api/email/email-1/attachment/0').set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(404);
        });
    });

    // ── POST /api/email/send ──────────────────────────────────────────────────
    describe('POST /api/email/send', () => {
        it('without auth → 401', async () => {
            const res = await request(app).post('/api/email/send').send({ to: 'x@y.com', subject: 'Hi' });
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('with staff role → 403', async () => {
            const res = await request(app).post('/api/email/send')
                .set(auth('staff')).send({ to: 'x@y.com', subject: 'Hi' });
            assertJson(res);
            expect(res.status).toBe(403);
        });

        it('missing to → 400', async () => {
            const res = await request(app).post('/api/email/send')
                .set(auth('admin')).send({ subject: 'Hi' });
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('missing subject → 400', async () => {
            const res = await request(app).post('/api/email/send')
                .set(auth('admin')).send({ to: 'x@y.com' });
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('valid → 200 (dev mode: logged, not really sent)', async () => {
            const res = await request(app).post('/api/email/send')
                .set(auth('admin')).send({ to: 'customer@example.com', subject: 'Hi', text: 'Hello!' });
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    // ── POST /api/email/:id/reply ─────────────────────────────────────────────
    describe('POST /api/email/:id/reply', () => {
        it('without auth → 401', async () => {
            const res = await request(app).post('/api/email/email-1/reply').send({ text: 'Thanks' });
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('missing text and html → 400', async () => {
            const res = await request(app).post('/api/email/email-1/reply')
                .set(auth('admin')).send({});
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('valid → 200 (dev mode: logged, not really sent)', async () => {
            const res = await request(app).post('/api/email/email-1/reply')
                .set(auth('admin')).send({ text: 'Thanks for reaching out!' });
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    // ── Folders (per-user; GET/POST /api/email/folders, DELETE /:id) ─────────
    describe('GET/POST/DELETE /api/email/folders', () => {
        it('GET without auth → 401', async () => {
            const res = await request(app).get('/api/email/folders');
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('starts empty for a fresh user', async () => {
            const res = await request(app).get('/api/email/folders').set(auth('siteAdmin'));
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual([]);
        });

        it('POST creates a folder, GET lists it', async () => {
            const create = await request(app).post('/api/email/folders').set(auth('admin')).send({ name: 'Projects' });
            assertJson(create);
            expect(create.status).toBe(201);
            expect(create.body.data.name).toBe('Projects');
            expect(create.body.data.is_trash).toBe(false);

            const list = await request(app).get('/api/email/folders').set(auth('admin'));
            expect(list.body.data.some(f => f.name === 'Projects')).toBe(true);
        });

        it('POST missing name → 400', async () => {
            const res = await request(app).post('/api/email/folders').set(auth('admin')).send({});
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('POST duplicate name for the same user → 409', async () => {
            await request(app).post('/api/email/folders').set(auth('admin')).send({ name: 'Dup' });
            const res = await request(app).post('/api/email/folders').set(auth('admin')).send({ name: 'Dup' });
            assertJson(res);
            expect(res.status).toBe(409);
        });

        it('DELETE removes a folder', async () => {
            const create = await request(app).post('/api/email/folders').set(auth('admin')).send({ name: 'ToDelete' });
            const del = await request(app).delete(`/api/email/folders/${create.body.data.id}`).set(auth('admin'));
            assertJson(del);
            expect(del.status).toBe(200);

            const list = await request(app).get('/api/email/folders').set(auth('admin'));
            expect(list.body.data.some(f => f.id === create.body.data.id)).toBe(false);
        });

        it("DELETE another user's folder → 404", async () => {
            const create = await request(app).post('/api/email/folders').set(auth('admin')).send({ name: 'Mine' });
            const del = await request(app).delete(`/api/email/folders/${create.body.data.id}`).set(auth('siteAdmin'));
            assertJson(del);
            expect(del.status).toBe(404);
        });

        it('DELETE the Trash folder → 400 (Trash is protected)', async () => {
            // Trash is created lazily — viewing it is enough to bring it into existence.
            await request(app).get('/api/email/inbox?folder=trash').set(auth('admin'));
            const list  = await request(app).get('/api/email/folders').set(auth('admin'));
            const trash = list.body.data.find(f => f.is_trash);
            expect(trash).toBeTruthy();

            const del = await request(app).delete(`/api/email/folders/${trash.id}`).set(auth('admin'));
            assertJson(del);
            expect(del.status).toBe(400);
        });
    });

    // ── PUT /api/email/:id/move ────────────────────────────────────────────────
    describe('PUT /api/email/:id/move', () => {
        it('without auth → 401', async () => {
            const res = await request(app).put('/api/email/email-1/move').send({ folder_id: null });
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('moves an email into a folder, then back to inbox', async () => {
            const create = await request(app).post('/api/email/folders').set(auth('admin')).send({ name: 'MoveTarget' });
            const folderId = create.body.data.id;

            const move = await request(app).put('/api/email/email-1/move').set(auth('admin')).send({ folder_id: folderId });
            assertJson(move);
            expect(move.status).toBe(200);

            const inFolder = await request(app).get(`/api/email/inbox?folder=${folderId}`).set(auth('admin'));
            expect(inFolder.body.data.map(e => e.id)).toContain('email-1');

            const inboxAfter = await request(app).get('/api/email/inbox').set(auth('admin'));
            expect(inboxAfter.body.data.map(e => e.id)).not.toContain('email-1');

            const back = await request(app).put('/api/email/email-1/move').set(auth('admin')).send({ folder_id: null });
            assertJson(back);
            expect(back.status).toBe(200);

            const inboxRestored = await request(app).get('/api/email/inbox').set(auth('admin'));
            expect(inboxRestored.body.data.map(e => e.id)).toContain('email-1');
        });

        it('move to a nonexistent folder → 404', async () => {
            const res = await request(app).put('/api/email/email-1/move').set(auth('admin')).send({ folder_id: 999999 });
            assertJson(res);
            expect(res.status).toBe(404);
        });

        it("moving into another user's folder → 404 (folder ownership enforced)", async () => {
            const create = await request(app).post('/api/email/folders').set(auth('admin')).send({ name: 'AdminOnly2' });
            const res = await request(app).put('/api/email/email-1/move').set(auth('siteAdmin')).send({ folder_id: create.body.data.id });
            assertJson(res);
            expect(res.status).toBe(404);
        });
    });

    // ── DELETE /api/email/:id (→ Trash) and /permanent ───────────────────────
    describe('DELETE /api/email/:id and /api/email/:id/permanent', () => {
        it('DELETE without auth → 401', async () => {
            const res = await request(app).delete('/api/email/email-1');
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('moves an email to Trash; inbox no longer shows it, trash view does', async () => {
            const del = await request(app).delete('/api/email/email-1').set(auth('admin'));
            assertJson(del);
            expect(del.status).toBe(200);

            const inbox = await request(app).get('/api/email/inbox').set(auth('admin'));
            expect(inbox.body.data.map(e => e.id)).not.toContain('email-1');

            const trash = await request(app).get('/api/email/inbox?folder=trash').set(auth('admin'));
            expect(trash.body.data.map(e => e.id)).toContain('email-1');
        });

        it('permanent delete before trashing → 400', async () => {
            const res = await request(app).delete('/api/email/email-2/permanent').set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('permanent delete after trashing → 200, calls S3 DeleteObjectCommand', async () => {
            await request(app).delete('/api/email/email-2').set(auth('admin')); // trash it first
            const before = s3Send.mock.calls.length;

            const res = await request(app).delete('/api/email/email-2/permanent').set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(200);

            const deleteCalls = s3Send.mock.calls.slice(before)
                .filter(([cmd]) => cmd.constructor.name === 'DeleteObjectCommand');
            expect(deleteCalls).toHaveLength(1);
            expect(deleteCalls[0][0].input.Key).toBe('emails/email-2');
        });
    });

    // ── GET /api/email/:id/download ──────────────────────────────────────────
    describe('GET /api/email/:id/download', () => {
        it('without auth → 401', async () => {
            const res = await request(app).get('/api/email/email-1/download');
            expect(res.status).toBe(401);
        });

        it('returns the raw .eml content', async () => {
            const res = await request(app).get('/api/email/email-1/download').set(auth('admin'));
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('message/rfc822');
            expect(res.headers['content-disposition']).toContain('email-1.eml');
            expect(res.text).toContain('Hi there');
        });
    });

    // ── GET /api/email/thread/download (zip) ─────────────────────────────────
    describe('GET /api/email/thread/download', () => {
        it('without auth → 401', async () => {
            const res = await request(app).get('/api/email/thread/download?ids=email-1,email-2');
            expect(res.status).toBe(401);
        });

        it('missing ids → 400', async () => {
            const res = await request(app).get('/api/email/thread/download').set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('returns a zip file containing the requested emails', async () => {
            const res = await request(app)
                .get('/api/email/thread/download?ids=email-1,email-2')
                .set(auth('admin'))
                .buffer(true)
                .parse((streamRes, cb) => {
                    const chunks = [];
                    streamRes.on('data', (c) => chunks.push(c));
                    streamRes.on('end', () => cb(null, Buffer.concat(chunks)));
                });
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('application/zip');
            expect(res.body.length).toBeGreaterThan(0);
            // A real zip starts with the "PK" local-file-header signature.
            expect(res.body.slice(0, 2).toString()).toBe('PK');
        });
    });

    // ── GET /api/email/:id/thread — reply-chain detection ────────────────────
    describe('GET /api/email/:id/thread', () => {
        const THREAD_ORIGINAL = [
            'From: Carol <carol@example.com>',
            'To: rajas@amaradata.com',
            'Subject: Thread Test',
            'Date: Wed, 3 Jun 2026 10:00:00 +0000',
            'Message-ID: <orig@example.com>',
            'Content-Type: text/plain',
            '',
            'Original message',
            '',
        ].join('\r\n');

        const THREAD_REPLY = [
            'From: Dave <dave@example.com>',
            'To: rajas@amaradata.com',
            'Subject: Re: Thread Test',
            'Date: Thu, 4 Jun 2026 10:00:00 +0000',
            'Message-ID: <reply@example.com>',
            'In-Reply-To: <orig@example.com>',
            'References: <orig@example.com>',
            'Content-Type: text/plain',
            '',
            'Reply message',
            '',
        ].join('\r\n');

        const UNRELATED = [
            'From: Eve <eve@example.com>',
            'To: rajas@amaradata.com',
            'Subject: Unrelated',
            'Date: Fri, 5 Jun 2026 10:00:00 +0000',
            'Message-ID: <unrelated@example.com>',
            'Content-Type: text/plain',
            '',
            'Not part of the thread',
            '',
        ].join('\r\n');

        let restoreImpl;
        beforeAll(() => {
            restoreImpl = s3Send.getMockImplementation();
            s3Send.mockImplementation(async (cmd) => {
                const name = cmd.constructor.name;
                if (name === 'ListObjectsV2Command') {
                    return { Contents: [
                        { Key: 'emails/thread-orig',      LastModified: new Date('2026-06-03T10:00:00Z') },
                        { Key: 'emails/thread-reply',      LastModified: new Date('2026-06-04T10:00:00Z') },
                        { Key: 'emails/thread-unrelated',  LastModified: new Date('2026-06-05T10:00:00Z') },
                    ]};
                }
                if (name === 'GetObjectCommand') {
                    const id = cmd.input.Key.replace('emails/', '');
                    const raw = id === 'thread-orig' ? THREAD_ORIGINAL : id === 'thread-reply' ? THREAD_REPLY : UNRELATED;
                    return { Body: Readable.from([Buffer.from(raw)]) };
                }
                throw new Error(`unmocked S3 command in thread test: ${name}`);
            });
        });
        afterAll(() => { s3Send.mockImplementation(restoreImpl); });

        it('without auth → 401', async () => {
            const res = await request(app).get('/api/email/thread-orig/thread');
            expect(res.status).toBe(401);
        });

        it('groups the original and its reply, excludes the unrelated email', async () => {
            const res = await request(app).get('/api/email/thread-orig/thread').set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(200);
            const ids = res.body.data.map(e => e.id);
            expect(ids).toContain('thread-orig');
            expect(ids).toContain('thread-reply');
            expect(ids).not.toContain('thread-unrelated');
        });

        it('nonexistent id → 404', async () => {
            const res = await request(app).get('/api/email/does-not-exist/thread').set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(404);
        });
    });
});
