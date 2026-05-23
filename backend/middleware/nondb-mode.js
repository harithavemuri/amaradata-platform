const db = require('../db');
const FileDbService = require('../services/file-db-service');

let _fileDb;

module.exports = function nondbMode(req, res, next) {
    if (process.env.NONDB_MODE === 'true') {
        if (!_fileDb) _fileDb = new FileDbService();
        req.db = { mode: 'nondb', fileDb: _fileDb };
    } else {
        req.db = { mode: 'db', query: db.query.bind(db) };
    }
    next();
};
