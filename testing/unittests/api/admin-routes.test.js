// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../../server.js';
import { uid, auth } from '../helpers.js';

describe('Admin API', () => {
    let userId;
    let groupId;

    beforeAll(async () => {
        const u = await request(app).post('/api/admin/users')
            .set(auth('siteAdmin'))
            .send({ email: `seed-${uid()}@t.com`, name: 'Seed User', role: 'staff' });
        userId = u.body.data?.id;

        const g = await request(app).post('/api/admin/user-groups')
            .set(auth('siteAdmin'))
            .send({ name: `Group-${uid()}` });
        groupId = g.body.data?.id;
    });

    // ── Users ─────────────────────────────────────────────────────────────────
    describe('GET /api/admin/users', () => {
        it('no auth → 401 JSON', async () => {
            const res = await request(app).get('/api/admin/users');
            expect(res.status).toBe(401);
            expect(res.headers['content-type']).toMatch(/json/);
        });

        it('admin role → 403 (site_admin required)', async () => {
            const res = await request(app).get('/api/admin/users').set(auth('admin'));
            expect(res.status).toBe(403);
        });

        it('staff role → 403', async () => {
            const res = await request(app).get('/api/admin/users').set(auth('staff'));
            expect(res.status).toBe(403);
        });

        it('site_admin → 200 with enriched users array', async () => {
            const res = await request(app).get('/api/admin/users').set(auth('siteAdmin'));
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(Array.isArray(res.body.data)).toBe(true);
        });

        it('response users have groups array and no password_hash', async () => {
            const res = await request(app).get('/api/admin/users').set(auth('siteAdmin'));
            expect(res.status).toBe(200);
            const user = res.body.data[0];
            expect(user).toHaveProperty('groups');
            expect(Array.isArray(user.groups)).toBe(true);
            expect(user).not.toHaveProperty('password_hash');
        });
    });

    describe('POST /api/admin/users', () => {
        it('no auth → 401', async () => {
            const res = await request(app).post('/api/admin/users')
                .send({ email: 'x@t.com', name: 'X' });
            expect(res.status).toBe(401);
        });

        it('admin role → 403', async () => {
            const res = await request(app).post('/api/admin/users')
                .set(auth('admin'))
                .send({ email: 'x@t.com', name: 'X' });
            expect(res.status).toBe(403);
        });

        it('missing email → 400 with error', async () => {
            const res = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ name: 'No Email', role: 'staff' });
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('missing name → 400', async () => {
            const res = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email: 'noname@t.com' });
            expect(res.status).toBe(400);
        });

        it('invalid role → 400', async () => {
            const res = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email: 'r@t.com', name: 'R', role: 'overlord' });
            expect(res.status).toBe(400);
        });

        it('valid → 201 without password_hash in response', async () => {
            const email = `new-${uid()}@t.com`;
            const res = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email, name: 'New User', role: 'billing', password: 'Secret1234' });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.email).toBe(email);
            expect(res.body.data.role).toBe('billing');
            expect(res.body.data).not.toHaveProperty('password_hash');
        });

        it('duplicate email → 409', async () => {
            const email = `dup-${uid()}@t.com`;
            await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email, name: 'First' });
            const res = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email, name: 'Second' });
            expect(res.status).toBe(409);
        });

        it.each(['site_admin', 'admin', 'sales_manager', 'billing', 'staff'])('valid role "%s" → 201', async (role) => {
            const res = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email: `role-${role}-${uid()}@t.com`, name: `Role ${role}`, role });
            expect(res.status).toBe(201);
            expect(res.body.data.role).toBe(role);
        });
    });

    describe('PUT /api/admin/users/:id', () => {
        it('nonexistent user → 404', async () => {
            const res = await request(app).put('/api/admin/users/99999')
                .set(auth('siteAdmin'))
                .send({ name: 'Ghost' });
            expect(res.status).toBe(404);
        });

        it('invalid role → 400', async () => {
            const res = await request(app).put(`/api/admin/users/${userId}`)
                .set(auth('siteAdmin'))
                .send({ role: 'overlord' });
            expect(res.status).toBe(400);
        });

        it('valid name/role update → 200', async () => {
            const res = await request(app).put(`/api/admin/users/${userId}`)
                .set(auth('siteAdmin'))
                .send({ name: 'Renamed User', role: 'billing' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.name).toBe('Renamed User');
            expect(res.body.data.role).toBe('billing');
        });

        it('deactivate user → 200 with is_active false', async () => {
            const res = await request(app).put(`/api/admin/users/${userId}`)
                .set(auth('siteAdmin'))
                .send({ is_active: false });
            expect(res.status).toBe(200);
            expect(res.body.data.is_active).toBe(false);
        });
    });

    describe('DELETE /api/admin/users/:id', () => {
        it('valid delete → 200', async () => {
            const u = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email: `del-${uid()}@t.com`, name: 'To Delete' });
            const res = await request(app).delete(`/api/admin/users/${u.body.data.id}`)
                .set(auth('siteAdmin'));
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('nonexistent user → 404', async () => {
            const res = await request(app).delete('/api/admin/users/99999')
                .set(auth('siteAdmin'));
            expect(res.status).toBe(404);
        });
    });

    // ── User Groups ────────────────────────────────────────────────────────────
    describe('GET /api/admin/user-groups', () => {
        it('site_admin → 200 with array', async () => {
            const res = await request(app).get('/api/admin/user-groups').set(auth('siteAdmin'));
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(Array.isArray(res.body.data)).toBe(true);
        });

        it('admin role → 403', async () => {
            const res = await request(app).get('/api/admin/user-groups').set(auth('admin'));
            expect(res.status).toBe(403);
        });
    });

    describe('POST /api/admin/user-groups', () => {
        it('valid → 201', async () => {
            const res = await request(app).post('/api/admin/user-groups')
                .set(auth('siteAdmin'))
                .send({ name: `NewGroup-${uid()}`, description: 'Desc' });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toHaveProperty('id');
        });

        it('missing name → 400', async () => {
            const res = await request(app).post('/api/admin/user-groups')
                .set(auth('siteAdmin'))
                .send({ description: 'No name' });
            expect(res.status).toBe(400);
        });
    });

    describe('Group membership — POST/DELETE members', () => {
        it('add user to group → 200/201', async () => {
            const u = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email: `mem-${uid()}@t.com`, name: 'Member User' });
            const res = await request(app)
                .post(`/api/admin/user-groups/${groupId}/members`)
                .set(auth('siteAdmin'))
                .send({ user_id: u.body.data.id });
            expect([200, 201]).toContain(res.status);
        });

        it('remove user from group → 200', async () => {
            const u = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email: `remv-${uid()}@t.com`, name: 'Remove User' });
            await request(app)
                .post(`/api/admin/user-groups/${groupId}/members`)
                .set(auth('siteAdmin'))
                .send({ user_id: u.body.data.id });
            const res = await request(app)
                .delete(`/api/admin/user-groups/${groupId}/members/${u.body.data.id}`)
                .set(auth('siteAdmin'));
            expect(res.status).toBe(200);
        });
    });

    // ── Roles ──────────────────────────────────────────────────────────────────
    describe('GET /api/admin/roles', () => {
        it('site_admin → 200 with roles array', async () => {
            const res = await request(app).get('/api/admin/roles').set(auth('siteAdmin'));
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.data)).toBe(true);
        });
    });

    describe('POST /api/admin/roles', () => {
        it('missing label → 400', async () => {
            const res = await request(app).post('/api/admin/roles')
                .set(auth('siteAdmin'))
                .send({ name: 'test_role', description: 'No label' });
            expect(res.status).toBe(400);
        });

        it('name with invalid chars → 400', async () => {
            const res = await request(app).post('/api/admin/roles')
                .set(auth('siteAdmin'))
                .send({ name: 'Bad-Role!', label: 'Bad Role' });
            expect(res.status).toBe(400);
        });

        it('valid name + label → 201', async () => {
            const name = `test_role_${uid().toLowerCase().replace(/[^a-z]/g, '')}`;
            const res = await request(app).post('/api/admin/roles')
                .set(auth('siteAdmin'))
                .send({ name, label: 'Test Role', description: 'Custom role' });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.name).toBe(name);
        });
    });
});
