// Test environment — set before any test file imports server.js
process.env.NONDB_MODE           = 'true';
process.env.AMRD_JWT_SECRET      = 'test-jwt-secret-32-chars-minimum!!';
process.env.SSO_SECRET           = 'test-sso-secret-32-chars-minimum!!';
process.env.ROHAS_URL            = 'http://localhost:8002';
process.env.GOOGLE_CLIENT_ID     = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI  = 'http://localhost/callback';
process.env.FRONTEND_URL         = 'http://localhost';
