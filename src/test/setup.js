import { afterAll }     from 'vitest';
import { createRequire } from 'module';
import { testDb }        from './test-db-config.js';

const _require = createRequire(import.meta.url);

if (!testDb.database.endsWith('_test')) {
    throw new Error(
        `REFUSED: test suite will not run against "${testDb.database}". ` +
        `Database name must end with _test.`
    );
}

// Point at the real test database — never NonDB mode
process.env.AMRD_DB_HOST     = testDb.host;
process.env.AMRD_DB_PORT     = String(testDb.port);
process.env.AMRD_DB_NAME     = testDb.database;
process.env.AMRD_DB_USER     = testDb.user;
process.env.AMRD_DB_PASSWORD = testDb.password;

process.env.AMRD_JWT_SECRET      = 'test-jwt-secret-32-chars-minimum!!';
process.env.SSO_SECRET           = 'test-sso-secret-32-chars-minimum!!';
process.env.ROHAS_URL            = 'http://localhost:8002';
process.env.GOOGLE_CLIENT_ID     = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI  = 'http://localhost/callback';
process.env.FRONTEND_URL         = 'http://localhost';
process.env.EMAIL_BUCKET         = 'test-email-bucket'; // backend/routes/email.js reads this at module load — S3/SES calls are mocked in email-routes.test.js

// Close pg connection pools after each test file so the worker process can exit cleanly.
// Without this the open pool handles keep the event loop alive and Vitest kills the
// worker with SIGKILL, producing "Worker exited unexpectedly".
// createRequire guarantees we get the same CJS module instance (same pool objects) that
// the test file used — dynamic ESM import() resolves through the ESM registry which may
// or may not be the same instance on all Node.js versions.
afterAll(async () => {
    try {
        const db = _require('../../backend/db.js');
        if (db?.writePool) await db.writePool.end();
        if (db?.readPool)  await db.readPool.end();
    } catch {
        // pool never opened in this worker (e.g. nondb-only test file) — safe to ignore
    }
});
