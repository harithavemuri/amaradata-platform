// @vitest-environment node
/**
 * Lightweight API performance SLA guard — see feedback-performance-sla.md.
 * Not a load/throughput benchmark (explicitly out of scope): one representative
 * request per route file, DB mode, asserting each stays under the 500ms SLA.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../../server.js';
import { auth } from '../helpers.js';

const SLA_MS = 500;

async function timed(fn) {
    const start = Date.now();
    const res   = await fn();
    return { res, duration: Date.now() - start };
}

describe('API performance SLA (<=500ms)', () => {
    it('GET /api/tenants', async () => {
        const { res, duration } = await timed(() => request(app).get('/api/tenants').set(auth('admin')));
        expect(res.status).toBe(200);
        expect(duration, `took ${duration}ms`).toBeLessThan(SLA_MS);
    });

    it('GET /api/invoices', async () => {
        const { res, duration } = await timed(() => request(app).get('/api/invoices').set(auth('admin')));
        expect(res.status).toBe(200);
        expect(duration, `took ${duration}ms`).toBeLessThan(SLA_MS);
    });

    it('GET /api/enhancements', async () => {
        const { res, duration } = await timed(() => request(app).get('/api/enhancements').set(auth('admin')));
        expect(res.status).toBe(200);
        expect(duration, `took ${duration}ms`).toBeLessThan(SLA_MS);
    });

    it('GET /api/metrics', async () => {
        const { res, duration } = await timed(() => request(app).get('/api/metrics').set(auth('admin')));
        expect(res.status).toBe(200);
        expect(duration, `took ${duration}ms`).toBeLessThan(SLA_MS);
    });

    it('GET /api/admin/users (site_admin)', async () => {
        const { res, duration } = await timed(() => request(app).get('/api/admin/users').set(auth('siteAdmin')));
        expect(res.status).toBe(200);
        expect(duration, `took ${duration}ms`).toBeLessThan(SLA_MS);
    });
});
