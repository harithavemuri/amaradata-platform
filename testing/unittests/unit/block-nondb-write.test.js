// @vitest-environment node
/**
 * backend/middleware/block-nondb-write.js — every write route uses this
 * instead of a req.db.mode==='nondb' branch of its own. It must block writes
 * in NonDB mode unconditionally, regardless of *why* the request landed in
 * NonDB mode (explicit NONDB_MODE=true, or an automatic db_unavailable
 * fallback — see nondb-mode.js) — a write must never reach file storage
 * either way. The only thing that changes by reason is the response: a
 * genuine DB outage gets the same 503 dbUnavailable shape every other write
 * failure in this codebase uses (services/http-errors.js), not the
 * structural "NonDB mode is read-only" 403, which would be a misleading
 * message during a real outage.
 */
import { describe, it, expect, vi } from 'vitest';
import { blockNonDbWrite } from '../../../backend/middleware/block-nondb-write.js';

function mockReqRes(dbMode) {
    const req = { db: dbMode };
    const res = { _status: null, _body: null };
    res.status = (code) => { res._status = code; return res; };
    res.json   = (body) => { res._body = body; return res; };
    const next = vi.fn();
    return { req, res, next };
}

describe('blockNonDbWrite', () => {
    it('lets a real DB-mode write through', () => {
        const { req, res, next } = mockReqRes({ mode: 'db' });
        blockNonDbWrite(req, res, next);
        expect(next).toHaveBeenCalledOnce();
        expect(res._status).toBeNull();
    });

    it('blocks an explicit NonDB-mode write with 403 and the read-only message', () => {
        const { req, res, next } = mockReqRes({ mode: 'nondb', reason: 'env' });
        blockNonDbWrite(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res._status).toBe(403);
        expect(res._body.error).toContain('read-only');
    });

    it('blocks a db_unavailable-triggered NonDB-mode write too — never reaches file storage', () => {
        const { req, res, next } = mockReqRes({ mode: 'nondb', reason: 'db_unavailable' });
        blockNonDbWrite(req, res, next);
        expect(next).not.toHaveBeenCalled();
    });

    it('gives the db_unavailable case the same 503 shape as a real DB connectivity failure, not the misleading 403', () => {
        const { req, res, next } = mockReqRes({ mode: 'nondb', reason: 'db_unavailable' });
        blockNonDbWrite(req, res, next);
        expect(res._status).toBe(503);
        expect(res._body.error).toBe('Service temporarily unavailable — please retry shortly.');
    });
});
