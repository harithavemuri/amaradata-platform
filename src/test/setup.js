import { testDb } from './test-db-config.js';

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
