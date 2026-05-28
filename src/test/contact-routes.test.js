// @vitest-environment node
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../server.js';
import { auth } from './helpers.js';

describe('Contact routes', () => {
    // ── POST /api/contact (public) ───────────────────────────────────────────
    describe('POST /api/contact', () => {
        it('missing name → 400', async () => {
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

        it('valid minimal → 201, returns ref_number', async () => {
            const res = await request(app).post('/api/contact')
                .send({ name: 'Alice', email: 'alice@example.com', message: 'Interested in your platform.' });
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
            expect(res.status).toBe(201);
            expect(res.body).toHaveProperty('ref_number');
        });

        it('no auth required (public endpoint)', async () => {
            const res = await request(app).post('/api/contact')
                .send({ name: 'Guest', email: 'guest@test.com', message: 'Public submission.' });
            expect(res.status).toBe(201);
        });
    });

    // ── GET /api/contact (admin) ─────────────────────────────────────────────
    describe('GET /api/contact', () => {
        it('without auth → 401', async () => {
            const res = await request(app).get('/api/contact');
            expect(res.status).toBe(401);
            expect(res.headers['content-type']).toMatch(/json/);
        });

        it('with staff auth → 200 with submissions array', async () => {
            const res = await request(app).get('/api/contact')
                .set(auth('staff'));
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(Array.isArray(res.body.data)).toBe(true);
        });

        it('includes previously submitted entries', async () => {
            await request(app).post('/api/contact')
                .send({ name: 'Charlie', email: 'charlie@test.com', message: 'Testing list.' });

            const res = await request(app).get('/api/contact').set(auth('staff'));
            expect(res.status).toBe(200);
            const entry = res.body.data.find(d => d.email === 'charlie@test.com');
            expect(entry).toBeTruthy();
            expect(entry.status).toBe('new');
        });
    });
});
