// @vitest-environment node
/**
 * One representative route per guard tier, exercised through the real Express
 * app (not mocked) — catches wiring mistakes the pure-unit matrix
 * (unit/role-guards.test.js) can't, e.g. a route accidentally using the wrong
 * guard. Complements, doesn't replace, that exhaustive unit-level matrix.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../../server.js';
import { auth, assertJson } from '../helpers.js';

const ROLES = ['siteAdmin', 'admin', 'staff', 'salesManager', 'billing'];

describe('role guard matrix (API level)', () => {
    // requireAuth: any authenticated role passes
    describe('GET /api/tenants/mine (requireAuth)', () => {
        for (const role of ROLES) {
            it(`${role} -> 200`, async () => {
                const res = await request(app).get('/api/tenants/mine').set(auth(role));
                assertJson(res);
                expect(res.status).toBe(200);
            });
        }
        it('no auth -> 401', async () => {
            const res = await request(app).get('/api/tenants/mine');
            assertJson(res);
            expect(res.status).toBe(401);
        });
    });

    // requireAdmin: admin + site_admin pass, others 403
    describe('POST /api/tenants (requireAdmin)', () => {
        const allowed = new Set(['admin', 'siteAdmin']);
        for (const role of ROLES) {
            it(`${role} -> ${allowed.has(role) ? '201' : '403'}`, async () => {
                const res = await request(app).post('/api/tenants')
                    .set(auth(role))
                    .send({ name: `Role Guard Test ${role} ${Date.now()}`, slug: `zzzzzz-role-guard-${role}-${Date.now()}` });
                assertJson(res);
                expect(res.status).toBe(allowed.has(role) ? 201 : 403);
            });
        }
        it('no auth -> 401', async () => {
            const res = await request(app).post('/api/tenants').send({ name: 'x', slug: 'x' });
            assertJson(res);
            expect(res.status).toBe(401);
        });
    });

    // requireSiteAdmin: only site_admin passes
    describe('GET /api/admin/users (requireSiteAdmin)', () => {
        for (const role of ROLES) {
            const shouldPass = role === 'siteAdmin';
            it(`${role} -> ${shouldPass ? '200' : '403'}`, async () => {
                const res = await request(app).get('/api/admin/users').set(auth(role));
                assertJson(res);
                expect(res.status).toBe(shouldPass ? 200 : 403);
            });
        }
        it('no auth -> 401', async () => {
            const res = await request(app).get('/api/admin/users');
            assertJson(res);
            expect(res.status).toBe(401);
        });
    });
});
