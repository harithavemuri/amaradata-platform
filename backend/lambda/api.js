const serverlessHttp = require('serverless-http');
const app            = require('../../server');

// API Gateway HTTP API includes the stage name in rawPath (e.g. /prod/health).
// basePath strips it so Express sees /health, /api/... etc.
// v2
exports.handler = serverlessHttp(app, { basePath: `/${process.env.NODE_ENV}` });
