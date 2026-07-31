// @vitest-environment node
import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { sign, signRefresh, verifyRefresh } from '../../../backend/middleware/auth.js';

describe('auth token helpers (pure, no HTTP/DB)', () => {
    it('sign() produces a JWT with type=access and a 15m expiry', () => {
        const token   = sign({ id: 1, role: 'admin' });
        const payload = jwt.decode(token);
        expect(payload.type).toBe('access');
        expect(payload.id).toBe(1);
        expect(payload.role).toBe('admin');
        expect(payload.exp - payload.iat).toBe(15 * 60);
    });

    it('signRefresh() produces a JWT with type=refresh and a 1h expiry', () => {
        const token   = signRefresh({ id: 1 });
        const payload = jwt.decode(token);
        expect(payload.type).toBe('refresh');
        expect(payload.exp - payload.iat).toBe(60 * 60);
    });

    it('verifyRefresh() returns the payload for a valid refresh token', () => {
        const token   = signRefresh({ id: 42, role: 'staff' });
        const payload = verifyRefresh(token);
        expect(payload.id).toBe(42);
        expect(payload.role).toBe('staff');
    });

    it('verifyRefresh() rejects an access token (wrong type)', () => {
        const accessToken = sign({ id: 1 });
        expect(() => verifyRefresh(accessToken)).toThrow('Not a refresh token');
    });

    it('verifyRefresh() rejects a token signed with a different secret', () => {
        const forged = jwt.sign({ id: 1, type: 'refresh' }, 'wrong-secret', { expiresIn: '1h' });
        expect(() => verifyRefresh(forged)).toThrow();
    });
});
