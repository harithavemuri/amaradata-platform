// @vitest-environment node
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../../server.js';
import { auth } from '../helpers.js';

describe('Contact API', () => {
    // ── POST /api/contact (public) ────────────────────────────────────────────
    describe('POST /api/contact', () => {
        it('missing name → 400 JSON', async () => {
            const res = await request(app).post('/api/contact')
                .send({ email: 'a@b.com', message: 'Hello' });
            expect(res.status).toBe(400);
            expect(res.headers['content-type']).toMatch(/json/);
            expect(res.body).toHaveProperty('error');
        });

        it('missing email → 400', async () => {
            const res = await request(app).post('/api/contact')
                .send({ name: 'Alice', message: 'Hello' });
            expect(res.status).toBe(400);
        });

        it('missing message → 400', async () => {
            const res = await request(app).post('/api/contact')
                .send({ name: 'Alice', email: 'a@b.com' });
            expect(res.status).toBe(400);
        });

        it('empty body → 400', async () => {
            const res = await request(app).post('/api/contact').send({});
            expect(res.status).toBe(400);
        });

        it('valid minimal → 201 with ref_number format REF-YYYYMMDD-####', async () => {
            const res = await request(app).post('/api/contact')
                .send({ name: 'Alice', email: 'alice@example.com', message: 'Platform enquiry.' });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.ref_number).toMatch(/^REF-\d{8}-\d{4}$/);
        });

        it('valid with optional fields (phone, company) → 201', async () => {
            const res = await request(app).post('/api/contact')
                .send({
                    name: 'Bob', email: 'bob@corp.com', message: 'Enquiry.',
                    phone: '+91-9876543210', company: 'Corp Ltd',
                });
            expect(res.status).toBe(201);
            expect(res.body).toHaveProperty('ref_number');
        });

        it('no auth required — public endpoint', async () => {
            const res = await request(app).post('/api/contact')
                .send({ name: 'Guest', email: 'guest@test.com', message: 'No auth needed.' });
            expect(res.status).toBe(201);
        });

        it('two submissions get unique ref_numbers', async () => {
            const [r1, r2] = await Promise.all([
                request(app).post('/api/contact')
                    .send({ name: 'X', email: 'x@t.com', message: 'First.' }),
                request(app).post('/api/contact')
                    .send({ name: 'Y', email: 'y@t.com', message: 'Second.' }),
            ]);
            expect(r1.body.ref_number).not.toBe(r2.body.ref_number);
        });
    });

    // ── GET /api/contact ──────────────────────────────────────────────────────
    describe('GET /api/contact', () => {
        it('no auth → 401 JSON', async () => {
            const res = await request(app).get('/api/contact');
            expect(res.status).toBe(401);
            expect(res.headers['content-type']).toMatch(/json/);
        });

        it('staff auth → 200 with array', async () => {
            const res = await request(app).get('/api/contact').set(auth('staff'));
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(Array.isArray(res.body.data)).toBe(true);
        });

        it('admin auth → 200', async () => {
            const res = await request(app).get('/api/contact').set(auth('admin'));
            expect(res.status).toBe(200);
        });

        it('previously submitted entry appears in list with status "new"', async () => {
            const email = `list-check-${Date.now()}@test.com`;
            await request(app).post('/api/contact')
                .send({ name: 'Charlie', email, message: 'List check.' });

            const res = await request(app).get('/api/contact').set(auth('staff'));
            expect(res.status).toBe(200);
            const entry = res.body.data.find(d => d.email === email);
            expect(entry).toBeTruthy();
            expect(entry.status).toBe('new');
            expect(entry.ref_number).toMatch(/^REF-/);
        });
    });
});
