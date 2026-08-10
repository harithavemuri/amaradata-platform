// @ts-check
/**
 * Classification logic for the generic DB-password rotation Lambda.
 *
 * This is the safety boundary for the auto-attach step in scripts/attach-secret-rotation.js:
 * every DB-ish secret in the account gets tested against isRotatableDbSecret()
 * before rotation is attached to it. A false positive here would attach password
 * rotation to a hostname or username secret and overwrite it with random text on
 * the next rotation, so the negative cases matter more than the positive ones.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { parseSecretId, isRotatableDbSecret } = require_('../../../backend/lambda/rotate-db-secret.js');

describe('parseSecretId — rotatable password secrets', () => {
    it('resolves a write-password secret to its username and host paths', () => {
        expect(parseSecretId('/amaradata/prod/db-write-password')).toEqual({
            tenant: 'amaradata', env: 'prod',
            userPath: '/amaradata/prod/db-write-user',
            hostPath: '/amaradata/prod/db-host',
        });
    });

    it('resolves a read-password secret', () => {
        expect(parseSecretId('/rohas/prod/db-read-password')).toMatchObject({
            userPath: '/rohas/prod/db-read-user',
            hostPath: '/rohas/prod/db-host',
        });
    });

    it('resolves an unprefixed db-password secret to db-user', () => {
        expect(parseSecretId('/rohas/prod/db-password')).toMatchObject({
            userPath: '/rohas/prod/db-user',
        });
    });

    it('works for a tenant and env it has never seen — no per-tenant config needed', () => {
        expect(parseSecretId('/newtenant/staging/db-write-password')).toMatchObject({
            tenant: 'newtenant', env: 'staging',
            userPath: '/newtenant/staging/db-write-user',
        });
    });

    it('accepts a full ARN, which is what Secrets Manager actually passes', () => {
        const arn = 'arn:aws:secretsmanager:ap-south-1:797666412164:secret:/amaradata/prod/db-write-password-AbCdEf';
        expect(parseSecretId(arn)).toMatchObject({ tenant: 'amaradata', env: 'prod' });
    });
});

describe('parseSecretId — secrets that must never be rotated', () => {
    // These live under the same prefix and would be swept up by a naive
    // "any secret matching db" filter, but they hold configuration. Rotating one
    // replaces a hostname or username with a random password.
    it.each([
        '/rohas/prod/db-host',
        '/rohas/prod/db-user',
        '/rohas/prod/db-read-user',
        '/rohas/prod/db-write-user',
        '/amaradata/prod/db-host',
    ])('rejects the config secret %s', (secretId) => {
        expect(parseSecretId(secretId)).toBeNull();
        expect(isRotatableDbSecret(secretId)).toBe(false);
    });

    it('rejects the Aurora master password — it is the credential rotation authenticates with', () => {
        expect(parseSecretId('/amaradata/aurora/master-password')).toBeNull();
        expect(isRotatableDbSecret('/amaradata/aurora/master-password')).toBe(false);
    });

    it.each([
        '/amaradata/prod/jwt-secret',
        '/amaradata/prod/google-client-secret',
        '/shared/prod/sso-secret',
        '/amaradata/prod/origin-secret',
    ])('rejects the non-DB secret %s', (secretId) => {
        expect(isRotatableDbSecret(secretId)).toBe(false);
    });

    it.each([
        ['a partial path', '/db-write-password'],
        ['a trailing segment', '/amaradata/prod/db-write-password/extra'],
        ['a lookalike name', '/amaradata/prod/db-write-password-backup'],
        ['an empty string', ''],
        ['a non-string', null],
    ])('rejects %s', (_label, secretId) => {
        expect(isRotatableDbSecret(/** @type {any} */ (secretId))).toBe(false);
    });
});
