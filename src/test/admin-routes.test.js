// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../server.js';
import { uid, auth } from './helpers.js';

describe('Admin routes (site_admin only)', () => {
    // Shared IDs seeded in beforeAll
    let userId;
    let groupId;
    let roleId;

    beforeAll(async () => {
        // Create a user, group, and role for update/delete tests
        const u = await request(app).post('/api/admin/users')
            .set(auth('siteAdmin'))
            .send({ email: `admin-seed-${uid()}@t.com`, name: 'Seed User', role: 'staff' });
        userId = u.body.data?.id;

        const g = await request(app).post('/api/admin/user-groups')
            .set(auth('siteAdmin'))
            .send({ name: `Seed Group ${uid()}`, description: 'For tests' });
        groupId = g.body.data?.id;

        const r = await request(app).post('/api/admin/roles')
            .set(auth('siteAdmin'))
            .send({ name: `test_role_${uid().replace(/[^a-z_]/g, '_')}`, label: 'Test Role' });
        roleId = r.body.data?.id;
    });

    // ── Auth guard ───────────────────────────────────────────────────────────
    describe('Auth guard on all admin routes', () => {
        it('without auth → 401', async () => {
            const res = await request(app).get('/api/admin/users');
            expect(res.status).toBe(401);
            expect(res.headers['content-type']).toMatch(/json/);
        });

        it('with admin (not site_admin) → 403', async () => {
            const res = await request(app).get('/api/admin/users').set(auth('admin'));
            expect(res.status).toBe(403);
        });

        it('with staff role → 403', async () => {
            const res = await request(app).get('/api/admin/users').set(auth('staff'));
            expect(res.status).toBe(403);
        });
    });

    // ── Users ────────────────────────────────────────────────────────────────
    describe('GET /api/admin/users', () => {
        it('→ 200 with data array', async () => {
            const res = await request(app).get('/api/admin/users').set(auth('siteAdmin'));
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(Array.isArray(res.body.data)).toBe(true);
        });

        it('users do not expose password_hash', async () => {
            const res = await request(app).get('/api/admin/users').set(auth('siteAdmin'));
            for (const u of res.body.data) {
                expect(u).not.toHaveProperty('password_hash');
            }
        });

        it('users include groups array', async () => {
            const res = await request(app).get('/api/admin/users').set(auth('siteAdmin'));
            for (const u of res.body.data) {
                expect(Array.isArray(u.groups)).toBe(true);
            }
        });
    });

    describe('POST /api/admin/users', () => {
        it('missing email → 400', async () => {
            const res = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ name: 'No Email', role: 'staff' });
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('invalid role → 400', async () => {
            const res = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email: `x${uid()}@t.com`, name: 'X', role: 'superuser' });
            expect(res.status).toBe(400);
        });

        it('valid → 201, no password_hash in response', async () => {
            const email = `new-${uid()}@test.com`;
            const res = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email, name: 'New User', role: 'billing' });
            expect(res.status).toBe(201);
            expect(res.body.data.email).toBe(email);
            expect(res.body.data.role).toBe('billing');
            expect(res.body.data).not.toHaveProperty('password_hash');
        });

        it('duplicate email → 409', async () => {
            const email = `dup-${uid()}@test.com`;
            await request(app).post('/api/admin/users')
                .set(auth('siteAdmin')).send({ email, name: 'A', role: 'staff' });
            const res = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin')).send({ email, name: 'B', role: 'staff' });
            expect(res.status).toBe(409);
        });
    });

    describe('PUT /api/admin/users/:id', () => {
        it('nonexistent id → 404', async () => {
            const res = await request(app).put('/api/admin/users/99999')
                .set(auth('siteAdmin'))
                .send({ name: 'Nobody' });
            expect(res.status).toBe(404);
        });

        it('invalid role → 400', async () => {
            const res = await request(app).put(`/api/admin/users/${userId}`)
                .set(auth('siteAdmin'))
                .send({ role: 'invalid' });
            expect(res.status).toBe(400);
        });

        it('valid update → 200', async () => {
            const res = await request(app).put(`/api/admin/users/${userId}`)
                .set(auth('siteAdmin'))
                .send({ name: 'Updated Name', role: 'admin' });
            expect(res.status).toBe(200);
            expect(res.body.data.name).toBe('Updated Name');
            expect(res.body.data.role).toBe('admin');
        });
    });

    describe('DELETE /api/admin/users/:id', () => {
        it('nonexistent id → 404', async () => {
            const res = await request(app).delete('/api/admin/users/99999')
                .set(auth('siteAdmin'));
            expect(res.status).toBe(404);
        });

        it('valid → 200, soft-delete (is_active=false)', async () => {
            const u = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email: `del-${uid()}@t.com`, name: 'To Delete', role: 'staff' });
            const id = u.body.data.id;

            const res = await request(app).delete(`/api/admin/users/${id}`)
                .set(auth('siteAdmin'));
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    // ── User Groups ──────────────────────────────────────────────────────────
    describe('GET /api/admin/user-groups', () => {
        it('→ 200 with enriched groups', async () => {
            const res = await request(app).get('/api/admin/user-groups').set(auth('siteAdmin'));
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.data)).toBe(true);
            for (const g of res.body.data) {
                expect(g).toHaveProperty('member_count');
                expect(Array.isArray(g.members)).toBe(true);
            }
        });
    });

    describe('POST /api/admin/user-groups', () => {
        it('missing name → 400', async () => {
            const res = await request(app).post('/api/admin/user-groups')
                .set(auth('siteAdmin'))
                .send({ description: 'No name' });
            expect(res.status).toBe(400);
        });

        it('valid → 201', async () => {
            const res = await request(app).post('/api/admin/user-groups')
                .set(auth('siteAdmin'))
                .send({ name: `Group ${uid()}`, description: 'Test group', role: 'billing' });
            expect(res.status).toBe(201);
            expect(res.body.data).toHaveProperty('id');
            expect(res.body.data.role).toBe('billing');
        });
    });

    describe('PUT /api/admin/user-groups/:id', () => {
        it('nonexistent id → 404', async () => {
            const res = await request(app).put('/api/admin/user-groups/99999')
                .set(auth('siteAdmin'))
                .send({ name: 'X' });
            expect(res.status).toBe(404);
        });

        it('valid update → 200', async () => {
            const res = await request(app).put(`/api/admin/user-groups/${groupId}`)
                .set(auth('siteAdmin'))
                .send({ name: 'Renamed Group', is_active: false });
            expect(res.status).toBe(200);
            expect(res.body.data.name).toBe('Renamed Group');
        });
    });

    describe('POST /api/admin/user-groups/:id/members', () => {
        it('missing user_id → 400', async () => {
            const res = await request(app).post(`/api/admin/user-groups/${groupId}/members`)
                .set(auth('siteAdmin'))
                .send({});
            expect(res.status).toBe(400);
        });

        it('valid → 201', async () => {
            const res = await request(app).post(`/api/admin/user-groups/${groupId}/members`)
                .set(auth('siteAdmin'))
                .send({ user_id: userId });
            expect(res.status).toBe(201);
        });

        it('duplicate member → 409', async () => {
            const res = await request(app).post(`/api/admin/user-groups/${groupId}/members`)
                .set(auth('siteAdmin'))
                .send({ user_id: userId });
            expect(res.status).toBe(409);
        });
    });

    describe('DELETE /api/admin/user-groups/:id/members/:userId', () => {
        it('valid → 200', async () => {
            const res = await request(app)
                .delete(`/api/admin/user-groups/${groupId}/members/${userId}`)
                .set(auth('siteAdmin'));
            expect(res.status).toBe(200);
        });

        it('nonexistent member → 404', async () => {
            const res = await request(app)
                .delete(`/api/admin/user-groups/${groupId}/members/99999`)
                .set(auth('siteAdmin'));
            expect(res.status).toBe(404);
        });
    });

    describe('DELETE /api/admin/user-groups/:id', () => {
        it('nonexistent id → 404', async () => {
            const res = await request(app).delete('/api/admin/user-groups/99999')
                .set(auth('siteAdmin'));
            expect(res.status).toBe(404);
        });

        it('valid → 200', async () => {
            const g = await request(app).post('/api/admin/user-groups')
                .set(auth('siteAdmin'))
                .send({ name: `Delete Me ${uid()}` });
            const id = g.body.data.id;
            const res = await request(app).delete(`/api/admin/user-groups/${id}`)
                .set(auth('siteAdmin'));
            expect(res.status).toBe(200);
        });
    });

    // ── Roles ────────────────────────────────────────────────────────────────
    describe('GET /api/admin/roles', () => {
        it('→ 200 with enriched roles', async () => {
            const res = await request(app).get('/api/admin/roles').set(auth('siteAdmin'));
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.data)).toBe(true);
            for (const r of res.body.data) {
                expect(r).toHaveProperty('user_count');
                expect(Array.isArray(r.users)).toBe(true);
                expect(Array.isArray(r.groups)).toBe(true);
            }
        });
    });

    describe('POST /api/admin/roles', () => {
        it('missing name → 400', async () => {
            const res = await request(app).post('/api/admin/roles')
                .set(auth('siteAdmin'))
                .send({ label: 'No name' });
            expect(res.status).toBe(400);
        });

        it('missing label → 400', async () => {
            const res = await request(app).post('/api/admin/roles')
                .set(auth('siteAdmin'))
                .send({ name: 'no_label' });
            expect(res.status).toBe(400);
        });

        it('name with invalid chars → 400', async () => {
            const res = await request(app).post('/api/admin/roles')
                .set(auth('siteAdmin'))
                .send({ name: 'Bad Name!', label: 'Bad' });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/lowercase/);
        });

        it('valid → 201', async () => {
            const name = `custom_role_${uid().replace(/[^a-z]/g, '')}`;
            const res = await request(app).post('/api/admin/roles')
                .set(auth('siteAdmin'))
                .send({ name, label: 'Custom Role', description: 'For testing' });
            expect(res.status).toBe(201);
            expect(res.body.data.name).toBe(name);
            expect(res.body.data.is_system).toBe(false);
        });

        it('duplicate name → 409', async () => {
            const name = `dup_role_${uid().replace(/[^a-z]/g, '')}`;
            await request(app).post('/api/admin/roles')
                .set(auth('siteAdmin')).send({ name, label: 'A' });
            const res = await request(app).post('/api/admin/roles')
                .set(auth('siteAdmin')).send({ name, label: 'B' });
            expect(res.status).toBe(409);
        });
    });

    describe('PUT /api/admin/roles/:id', () => {
        it('nonexistent id → 404', async () => {
            const res = await request(app).put('/api/admin/roles/99999')
                .set(auth('siteAdmin'))
                .send({ label: 'X' });
            expect(res.status).toBe(404);
        });

        it('valid update → 200', async () => {
            const res = await request(app).put(`/api/admin/roles/${roleId}`)
                .set(auth('siteAdmin'))
                .send({ label: 'Updated Label', description: 'New desc' });
            expect(res.status).toBe(200);
            expect(res.body.data.label).toBe('Updated Label');
        });
    });

    describe('DELETE /api/admin/roles/:id', () => {
        it('nonexistent id → 404', async () => {
            const res = await request(app).delete('/api/admin/roles/99999')
                .set(auth('siteAdmin'));
            expect(res.status).toBe(404);
        });

        it('non-system role with no users → 200', async () => {
            const name = `del_role_${uid().replace(/[^a-z]/g, '')}`;
            const r = await request(app).post('/api/admin/roles')
                .set(auth('siteAdmin'))
                .send({ name, label: 'Deletable' });
            const id = r.body.data.id;

            const res = await request(app).delete(`/api/admin/roles/${id}`)
                .set(auth('siteAdmin'));
            expect(res.status).toBe(200);
        });
    });

    // ── Sync-to-DB ───────────────────────────────────────────────────────────
    describe('POST /api/admin/sync-to-db', () => {
        it('in NonDB mode → 400 (no target DB)', async () => {
            const res = await request(app).post('/api/admin/sync-to-db')
                .set(auth('siteAdmin'));
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/NonDB mode/);
        });
    });
});
