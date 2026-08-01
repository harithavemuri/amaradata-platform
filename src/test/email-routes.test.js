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
import { vi, describe, it, expect, beforeAll } from 'vitest';
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
});
