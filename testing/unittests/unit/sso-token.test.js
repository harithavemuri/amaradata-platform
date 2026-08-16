// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { signSsoToken } from '../../../backend/services/sso-token.js';

const SECRET = 'test-sso-secret-32-chars-minimum!!';

function decode(token) {
    const [header, body, sig] = token.split('.');
    return { header: JSON.parse(Buffer.from(header, 'base64url')), body: JSON.parse(Buffer.from(body, 'base64url')), sig };
}

describe('signSsoToken', () => {
    it('produces a 3-part compact JWT', () => {
        const token = signSsoToken(SECRET, { aud: 'rohas', sub: 'a@t.com', name: 'A', role: 'super_admin' });
        expect(token.split('.')).toHaveLength(3);
    });

    it('payload carries iss/aud/sub/name/role and a 60s default expiry', () => {
        const before = Math.floor(Date.now() / 1000);
        const token = signSsoToken(SECRET, { aud: 'rohas', sub: 'a@t.com', name: 'A', role: 'super_admin' });
        const { body } = decode(token);
        expect(body.iss).toBe('amaradata');
        expect(body.aud).toBe('rohas');
        expect(body.sub).toBe('a@t.com');
        expect(body.name).toBe('A');
        expect(body.role).toBe('super_admin');
        expect(body.exp - body.iat).toBe(60);
        expect(body.iat).toBeGreaterThanOrEqual(before);
    });

    it('honors a custom ttlSeconds', () => {
        const token = signSsoToken(SECRET, { aud: 'rohas', sub: 'a@t.com', name: 'A', role: 'admin', ttlSeconds: 30 });
        const { body } = decode(token);
        expect(body.exp - body.iat).toBe(30);
    });

    it('signature changes if the secret changes', () => {
        const t1 = signSsoToken(SECRET, { aud: 'rohas', sub: 'a@t.com', name: 'A', role: 'admin' });
        const t2 = signSsoToken('a-different-secret-32-chars-min!!', { aud: 'rohas', sub: 'a@t.com', name: 'A', role: 'admin' });
        expect(decode(t1).sig).not.toBe(decode(t2).sig);
    });
});
