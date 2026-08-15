// @vitest-environment node
/**
 * backend/db.js's S3-backed write-mirror. Lambda's deployment package
 * (/var/task) is read-only outside /tmp, so ApiFn writes transactiondata/
 * mirrors to S3 instead of local disk when TRANSACTIONDATA_S3_BUCKET is set
 * (template.yaml sets it only for ApiFn — see project-nondb-read-only.md).
 *
 * Separate file from db-query-resilience.test.js: TRANSACTIONDATA_S3_BUCKET,
 * like TRANSACTIONDATA_DIR, is read once at db.js's module-load time, so the
 * local-disk-mode tests and this S3-mode file can't share one require of db.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

process.env.TRANSACTIONDATA_S3_BUCKET = 'test-transactiondata-bucket';

// testing/unittests/setup.js sets NONDB_MODE=true for the whole run — db.js
// short-circuits to a throwing stub under that flag (same as
// db-query-resilience.test.js's identical workaround).
const wasNonDb = process.env.NONDB_MODE;
delete process.env.NONDB_MODE;
const dbModule = require_('../../../backend/db.js');
if (wasNonDb !== undefined) process.env.NONDB_MODE = wasNonDb;

// vi.mock('@aws-sdk/client-s3') does not reliably intercept db.js's own
// nested require() of it (same CJS-require gotcha as 'pg' — confirmed
// empirically: an earlier version of this test using vi.mock reached real
// AWS and got a clean NoSuchBucket error back). Instead, monkey-patch .send
// directly on the real (never actually connected-to) S3Client instance db.js
// lazily creates and exposes via _s3(), the same pattern used for
// writePool/readPool.query elsewhere.
const sendMock = vi.fn();
dbModule._s3().send = sendMock;

const queryMock = vi.fn();
dbModule.writePool.query = queryMock;
dbModule.readPool.query  = queryMock;

beforeEach(() => { queryMock.mockReset(); sendMock.mockReset(); });

describe('db.js — S3-backed mirror (TRANSACTIONDATA_S3_BUCKET set)', () => {
    it('mirrorTableToFile() PUTs the table JSON to S3 instead of writing to disk', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Acme' }] });
        sendMock.mockResolvedValueOnce({});

        const rows = await dbModule.mirrorTableToFile('tenants');

        expect(rows).toBe(1);
        expect(sendMock).toHaveBeenCalledTimes(1);
        const putCommand = sendMock.mock.calls[0][0];
        expect(putCommand.input.Bucket).toBe('test-transactiondata-bucket');
        expect(putCommand.input.Key).toBe('tenants.json');
        expect(JSON.parse(putCommand.input.Body)).toEqual([{ id: 1, name: 'Acme' }]);
    });

    it('readMirroredTableFile() GETs from S3 and returns the body as a string', async () => {
        const { Readable } = await import('node:stream');
        sendMock.mockResolvedValueOnce({ Body: Readable.from([Buffer.from('[{"id":1}]')]) });

        const content = await dbModule.readMirroredTableFile('tenants');
        expect(content).toBe('[{"id":1}]');
    });

    it('readMirroredTableFile() returns null when the object does not exist', async () => {
        sendMock.mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'NoSuchKey' }));
        const content = await dbModule.readMirroredTableFile('tenants');
        expect(content).toBeNull();
    });
});
