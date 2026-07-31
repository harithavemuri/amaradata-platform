// @vitest-environment node
/**
 * Exhaustive unit matrix: every guard (requireAuth/requireAdmin/requireSiteAdmin)
 * x every role (site_admin/admin/sales_manager/billing/staff), asserting the
 * expected 200-vs-401/403 outcome. Pure unit level — mocked req/res, no HTTP/DB
 * (see feedback-test-layers-db-first.md's definition of the unit layer).
 */
import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { requireAuth, requireAdmin, requireSiteAdmin } from '../../../backend/middleware/auth.js';

const SECRET = process.env.AMRD_JWT_SECRET;
const ROLES  = ['site_admin', 'admin', 'sales_manager', 'billing', 'staff'];

function tokenFor(role) {
    return jwt.sign({ id: 1, email: `${role}@t.com`, name: role, role, type: 'access' }, SECRET, { expiresIn: '1h' });
}

function mockReqRes(token) {
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = { _status: null, _body: null };
    res.status = (code) => { res._status = code; return res; };
    res.json   = (body) => { res._body = body; return res; };
    const next = vi.fn();
    return { req, res, next };
}

const GUARDS = {
    requireAuth:       { fn: requireAuth,       allowed: new Set(ROLES) },                     // any authenticated role
    requireAdmin:      { fn: requireAdmin,      allowed: new Set(['admin', 'site_admin']) },
    requireSiteAdmin:  { fn: requireSiteAdmin,  allowed: new Set(['site_admin']) },
};

describe('role guard matrix (unit, no HTTP)', () => {
    for (const [guardName, { fn, allowed }] of Object.entries(GUARDS)) {
        describe(guardName, () => {
            for (const role of ROLES) {
                const shouldPass = allowed.has(role);
                it(`${role} -> ${shouldPass ? 'passes (calls next)' : 'blocked (403)'}`, () => {
                    const { req, res, next } = mockReqRes(tokenFor(role));
                    fn(req, res, next);
                    if (shouldPass) {
                        expect(next).toHaveBeenCalledOnce();
                        expect(res._status).toBeNull();
                    } else {
                        expect(next).not.toHaveBeenCalled();
                        expect(res._status).toBe(403);
                    }
                });
            }

            it('no token -> 401, next not called', () => {
                const { req, res, next } = mockReqRes(null);
                fn(req, res, next);
                expect(next).not.toHaveBeenCalled();
                expect(res._status).toBe(401);
            });

            it('invalid token -> 401, next not called', () => {
                const { req, res, next } = mockReqRes('not-a-real-jwt');
                fn(req, res, next);
                expect(next).not.toHaveBeenCalled();
                expect(res._status).toBe(401);
            });

            it('refresh-type token -> 401, next not called', () => {
                const refreshToken = jwt.sign({ id: 1, role: 'site_admin', type: 'refresh' }, SECRET, { expiresIn: '1h' });
                const { req, res, next } = mockReqRes(refreshToken);
                fn(req, res, next);
                expect(next).not.toHaveBeenCalled();
                expect(res._status).toBe(401);
            });
        });
    }
});
