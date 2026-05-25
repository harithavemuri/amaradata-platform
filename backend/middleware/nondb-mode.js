const db = require('../db');
const FileDbService = require('../services/file-db-service');

let _fileDb;

module.exports = function nondbMode(req, res, next) {
    if (process.env.NONDB_MODE === 'true') {
        if (!_fileDb) {
            _fileDb = new FileDbService();
            console.warn(JSON.stringify({ level: 'WARN', event: 'nondb_active', reason: 'NONDB_MODE=true' }));
        }
        req.db = { mode: 'nondb', fileDb: _fileDb };
        res.setHeader('X-DB-Mode', 'nondb');
        res.setHeader('X-DB-Mode-Reason', 'env');
        console.warn(JSON.stringify({ level: 'WARN', event: 'nondb_request', method: req.method, path: req.path }));
    } else {
        req.db = { mode: 'db', query: db.query.bind(db) };
    }
    next();
};
