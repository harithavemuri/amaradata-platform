// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
import app from '../../server.js';
import { auth, assertJson } from './helpers.js';

// vi.mock() doesn't reliably intercept require('../services/ses') nested inside
// server.js's own CJS require graph (same finding as email-routes.test.js /
// email-s3-client.js) — createRequire(import.meta.url) reaches the exact
// module instance contact.js's own require() sees.
const _require = createRequire(import.meta.url);
const sesService = _require('../../backend/services/ses.js');

describe('Contact routes', () => {
    // ── POST /api/contact (public) ───────────────────────────────────────────
    describe('POST /api/contact', () => {
        it('missing name → 400', async () => {
            const res = await request(app).post('/api/contact')
                .send({ email: 'a@b.com', message: 'Hello' });
            assertJson(res);
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('missing email → 400', async () => {
            const res = await request(app).post('/api/contact')
                .send({ name: 'Alice', message: 'Hello' });
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('missing message → 400', async () => {
            const res = await request(app).post('/api/contact')
                .send({ name: 'Alice', email: 'a@b.com' });
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('valid minimal → 201, returns ref_number', async () => {
            const res = await request(app).post('/api/contact')
                .send({ name: 'Alice', email: 'alice@example.com', message: 'Interested in your platform.' });
            assertJson(res);
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.ref_number).toMatch(/^REF-\d{8}-\d{4}$/);
        });

        it('valid with optional fields → 201', async () => {
            const res = await request(app).post('/api/contact')
                .send({
                    name: 'Bob', email: 'bob@corp.com', message: 'Enquiry.',
                    phone: '+91-9876543210', company: 'Corp Ltd',
                });
            assertJson(res);
            expect(res.status).toBe(201);
            expect(res.body).toHaveProperty('ref_number');
        });

        it('no auth required (public endpoint)', async () => {
            const res = await request(app).post('/api/contact')
                .send({ name: 'Guest', email: 'guest@test.com', message: 'Public submission.' });
            assertJson(res);
            expect(res.status).toBe(201);
        });

        // Regression test: sendAdminEmail(row) in contact.js was previously
        // fire-and-forget (not awaited). Harmless in a long-running Node
        // process (the promise eventually resolves regardless), but fatal in
        // Lambda — AWS freezes the execution environment immediately after the
        // HTTP response is sent, killing any still-in-flight, un-awaited
        // promise before it completes. Confirmed in production: the contact
        // form's admin-notification email was never arriving (SES
        // SentLast24Hours stayed at 0, and CloudWatch showed zero
        // console output between the Lambda's platform.start/platform.report
        // lines — the email send never got far enough to even hit its own
        // try/catch's console.warn on failure). This test asserts the real
        // correctness property regardless of environment: the response must
        // not be sent until the admin-notification email attempt has settled.
        it('awaits the admin-notification email before responding (regression: was fire-and-forget)', async () => {
            let resolved = false;
            const spy = vi.spyOn(sesService, 'sendEmail').mockImplementation(() =>
                new Promise((resolve) => setTimeout(() => { resolved = true; resolve(); }, 50))
            );

            const res = await request(app).post('/api/contact')
                .send({ name: 'Dana', email: 'dana@example.com', message: 'Timing check.' });

            assertJson(res);
            expect(res.status).toBe(201);
            expect(spy).toHaveBeenCalledTimes(1);
            // If sendAdminEmail() were fire-and-forget, the response would arrive
            // well before the 50ms mock delay elapses, and `resolved` would still
            // be false here.
            expect(resolved).toBe(true);

            spy.mockRestore();
        });
    });

    // ── GET /api/contact (admin) ─────────────────────────────────────────────
    describe('GET /api/contact', () => {
        it('without auth → 401', async () => {
            const res = await request(app).get('/api/contact');
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('with staff auth → 200 with submissions array', async () => {
            const res = await request(app).get('/api/contact')
                .set(auth('staff'));
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(Array.isArray(res.body.data)).toBe(true);
        });

        it('includes previously submitted entries', async () => {
            await request(app).post('/api/contact')
                .send({ name: 'Charlie', email: 'charlie@test.com', message: 'Testing list.' });

            const res = await request(app).get('/api/contact').set(auth('staff'));
            assertJson(res);
            expect(res.status).toBe(200);
            const entry = res.body.data.find(d => d.email === 'charlie@test.com');
            expect(entry).toBeTruthy();
            expect(entry.status).toBe('new');
        });
    });
});
