// Isolated from backend/routes/email.js so tests can mock this project file
// directly (src/test/email-routes.test.js) — vi.mock() reliably intercepts
// project-file imports, but was not reliably intercepting the nested
// require('@aws-sdk/client-s3') call from inside email.js itself.
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

const EMAIL_REGION = 'us-east-1';
const s3 = new S3Client({ region: EMAIL_REGION });

module.exports = { s3, ListObjectsV2Command, GetObjectCommand };
