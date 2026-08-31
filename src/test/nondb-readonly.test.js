// @vitest-environment node
/**
 * NonDB mode is read-only (see project-nondb-read-only.md). This replaces the
 * old dual-mode run of src/test/*.test.js under vitest.config.nondb.js — those
 * files assume every write succeeds in both modes, which stopped being true
 * once backend/middleware/block-nondb-write.js was wired into every write
 * route. Full CRUD-workflow coverage stays DB-mode-only (the default
 * vitest.config.js run); this file's job is narrower: prove GET routes still
 * read from files, and that write attempts are rejected, without needing a
 * create-then-read chain (fixtures are seeded directly as files, not via API).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs      from 'fs';
import path    from 'path';
import bcrypt  from 'bcryptjs';
import request from 'supertest';
import app     from '../../server.js';
import { auth, assertJson } from './helpers.js';

const DATA_DIR = process.env.TRANSACTIONDATA_DIR;

function seed(table, rows) {
    fs.writeFileSync(path.join(DATA_DIR, `${table}.json`), JSON.stringify(rows));
}
function read(table) {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${table}.json`), 'utf8'));
}

const READ_ONLY = 'NonDB mode is read-only — writes are not supported.';

beforeAll(async () => {
    seed('tenants', [{ id: 1, name: 'Acme', slug: 'acme', status: 'active' }]);
    seed('invoices', [{ id: 1, tenant_id: 1, invoice_number: 'AMR-2026-0001', status: 'draft' }]);
    seed('enhancements', [{ id: 1, tenant_id: 1, title: 'Seeded', status: 'scoped' }]);
    seed('subscription_plans', [{ id: 1, name: 'Standard' }, { id: 2, name: 'Suggest Plan', sales_pct: 5, rental_pct: 10, min_monthly_fee: 2000, currency_code: 'INR' }]);
    seed('tenant_subscriptions', [{ id: 1, tenant_id: 1, plan_id: 2, effective_from: '2020-01-01', effective_to: null }]);
    seed('billing_metrics', [{ id: 1, tenant_id: 1, period_year: 2026, period_month: 6, sales_count: 2, sales_value: 1000000, rental_units: 3, rental_income: 50000, active_properties: 10 }]);
    seed('billing_contacts', [{ id: 1, name: 'Seeded Billing Contact', email: 'bc@x.com' }]);
    seed('billing_contact_scopes', [{ id: 1, billing_contact_id: 1, tenant_id: 1, scope_type: 'tenant', tenant_project_id: null, tenant_property_id: null }]);
    seed('contact_submissions', [{ id: 1, ref_number: 'REF-1', name: 'X', email: 'x@x.com', message: 'hi' }]);
    seed('amr_roles', [{ id: 1, name: 'staff', label: 'Staff', is_system: true }]);
    seed('amr_users', [{
        id: 1, username: 'reader', email: 'reader@t.com', name: 'Reader', role: 'staff',
        password_hash: await bcrypt.hash('correctpassword', 12), is_active: true,
    }, {
        id: 2, username: 'owner', email: 'owner@t.com', name: 'Owner', role: 'property_owner',
        password_hash: await bcrypt.hash('correctpassword', 12), is_active: true,
    }]);
    seed('login_audit', []);
});

describe('NonDB mode — reads still work', () => {
    it('GET /api/tenants returns seeded file data', async () => {
        const res = await request(app).get('/api/tenants').set(auth('staff'));
        assertJson(res);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([{ id: 1, name: 'Acme', slug: 'acme', status: 'active' }]);
    });

    it('GET /api/invoices returns seeded file data', async () => {
        const res = await request(app).get('/api/invoices').set(auth('staff'));
        assertJson(res);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
    });

    it('GET /api/enhancements returns seeded file data', async () => {
        const res = await request(app).get('/api/enhancements').set(auth('staff'));
        assertJson(res);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
    });

    it('GET /api/admin/users (super_admin) returns seeded file data', async () => {
        const res = await request(app).get('/api/admin/users').set(auth('siteAdmin'));
        assertJson(res);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2); // 'reader' (staff) + 'owner' (property_owner)
    });

    it('GET /api/admin/roles (super_admin) returns seeded file data', async () => {
        const res = await request(app).get('/api/admin/roles').set(auth('siteAdmin'));
        assertJson(res);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
    });

    it('GET /api/contact (admin) returns seeded file data', async () => {
        const res = await request(app).get('/api/contact').set(auth('admin'));
        assertJson(res);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
    });

    it('GET /api/invoices/suggest-line-items computes commission from seeded files, same as DB mode', async () => {
        const res = await request(app)
            .get('/api/invoices/suggest-line-items?tenant_id=1&period_year=2026&period_month=6')
            .set(auth('staff'));
        assertJson(res);
        expect(res.status).toBe(200);
        const sales  = res.body.data.line_items.find((l) => l.billing_type === 'sales_pct');
        const rental = res.body.data.line_items.find((l) => l.billing_type === 'rental_pct');
        expect(sales.amount).toBe(50000);  // 5% of 1,000,000
        expect(rental.amount).toBe(5000);  // 10% of 50,000
    });

    it('GET /api/billing-contacts/resolve resolves the seeded tenant-level scope from files, same as DB mode', async () => {
        const res = await request(app)
            .get('/api/billing-contacts/resolve?tenant_id=1')
            .set(auth('staff'));
        assertJson(res);
        expect(res.status).toBe(200);
        expect(res.body.data.billing_contact_id).toBe(1);
        expect(res.body.data.matched_scope).toBe('tenant');
    });
});

describe('NonDB mode — writes are rejected', () => {
    const CASES = [
        ['POST',   '/api/tenants',                          'admin',     { name: 'X', slug: 'x' }],
        ['PUT',    '/api/tenants/1',                         'admin',     { name: 'X' }],
        ['POST',   '/api/invoices',                          'admin',     { tenant_id: 1, issue_date: '2026-01-01', due_date: '2026-01-15' }],
        ['PATCH',  '/api/invoices/1/status',                 'admin',     { status: 'sent' }],
        ['POST',   '/api/enhancements',                      'admin',     { tenant_id: 1, title: 'X' }],
        ['PUT',    '/api/enhancements/1',                    'admin',     { title: 'X' }],
        ['DELETE', '/api/enhancements/1',                    'admin',     undefined],
        ['POST',   '/api/enhancements/import',                'admin',     { tenant_id: 1, rows: [{ issue_id: 1 }] }],
        ['POST',   '/api/metrics',                            'staff',     { tenant_id: 1, period_year: 2026, period_month: 1 }],
        ['POST',   '/api/subscriptions/plans',                'admin',     { name: 'X' }],
        ['DELETE', '/api/subscriptions/plans/1',              'admin',     undefined],
        ['POST',   '/api/subscriptions',                      'admin',     { tenant_id: 1, plan_id: 1, effective_from: '2026-01-01' }],
        ['POST',   '/api/billing-contacts',                   'admin',     { name: 'X', email: 'x@x.com' }],
        ['PUT',    '/api/billing-contacts/1',                 'admin',     { name: 'X' }],
        ['DELETE', '/api/billing-contacts/1',                 'admin',     undefined],
        ['POST',   '/api/billing-contacts/1/scopes',          'admin',     { tenant_id: 1, scope_type: 'tenant' }],
        ['POST',   '/api/billing-contacts/1/scopes/bulk',     'admin',     { scopes: [{ tenant_id: 1, scope_type: 'tenant' }] }],
        ['DELETE', '/api/billing-contacts/scopes/1',          'admin',     undefined],
        ['POST',   '/api/contact',                            null,        { name: 'X', email: 'x@x.com', message: 'hi' }],
        ['POST',   '/api/admin/users',                        'siteAdmin', { email: 'x@x.com', name: 'X' }],
        ['PUT',    '/api/admin/users/1',                      'siteAdmin', { name: 'X' }],
        ['DELETE', '/api/admin/users/1',                      'siteAdmin', undefined],
        ['POST',   '/api/admin/user-groups',                  'siteAdmin', { name: 'X' }],
        ['POST',   '/api/admin/roles',                        'siteAdmin', { name: 'x', label: 'X' }],
        ['PUT',    '/api/admin/roles/1',                      'siteAdmin', { label: 'X' }],
        ['DELETE', '/api/admin/roles/1',                      'siteAdmin', undefined],
        ['POST',   '/api/email/folders',                      'admin',     { name: 'X' }],
        ['PUT',    '/api/email/some-id/move',                 'admin',     { folder_id: null }],
        ['DELETE', '/api/email/some-id',                      'admin',     undefined],
        ['POST',   '/api/auth/create-user',                   null,        { email: 'x@x.com', password: 'x', name: 'X', setup_key: 'wrong' }],
        ['POST',   '/api/auth/forgot-password',               null,        { email: 'reader@t.com' }],
        ['POST',   '/api/auth/reset-password',                null,        { token: 'x', password: 'longenough1' }],
    ];

    it.each(CASES)('%s %s → 403 read-only', async (method, url, role, body) => {
        let r = request(app)[method.toLowerCase()](url);
        if (role) r = r.set(auth(role));
        if (body !== undefined) r = r.send(body);
        const res = await r;
        assertJson(res);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe(READ_ONLY);
    });
});

describe('NonDB mode — login audit is the one write exception', () => {
    it('POST /api/auth/login succeeds and records last_login_at + a login_audit row', async () => {
        const res = await request(app).post('/api/auth/login')
            .send({ username: 'reader', password: 'correctpassword' });
        assertJson(res);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        expect(read('amr_users')[0].last_login_at).toBeTruthy();
        const audit = read('login_audit');
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ user_id: 1, method: 'password' });
    });

    // property_owner isolation (see [[project_owner_portal]] in rohas-group's
    // memory) applies in every mode, not just DB mode.
    it('POST /api/auth/login rejects a property_owner account with 403, no audit row', async () => {
        const res = await request(app).post('/api/auth/login')
            .send({ username: 'owner', password: 'correctpassword' });
        assertJson(res);
        expect(res.status).toBe(403);
        expect(res.body).not.toHaveProperty('token');
        expect(read('login_audit')).toHaveLength(1); // still just the prior test's row
    });
});
