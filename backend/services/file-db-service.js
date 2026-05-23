const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.TRANSACTIONDATA_DIR
    ? path.resolve(process.env.TRANSACTIONDATA_DIR)
    : path.join(__dirname, '../../transactiondata');

class FileDbService {
    _filePath(table) {
        return path.join(DATA_DIR, `${table}.json`);
    }

    _read(table) {
        const file = this._filePath(table);
        if (!fs.existsSync(file)) return [];
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
    }

    _write(table, rows) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(this._filePath(table), JSON.stringify(rows, null, 2));
    }

    find(table, filter = {}) {
        let rows = this._read(table);
        for (const [k, v] of Object.entries(filter)) {
            if (v !== undefined) {
                // null == null and null == undefined — intentional loose equality for optional fields
                rows = rows.filter(r => r[k] == v);
            }
        }
        return rows;
    }

    getById(table, id) {
        return this._read(table).find(r => r.id == id) || null;
    }

    create(table, data) {
        const rows  = this._read(table);
        const maxId = rows.reduce((m, r) => Math.max(m, r.id || 0), 0);
        const now   = new Date().toISOString();
        const row   = { id: maxId + 1, created_at: now, updated_at: now, ...data };
        rows.push(row);
        this._write(table, rows);
        return row;
    }

    update(table, id, updates) {
        const rows = this._read(table);
        const idx  = rows.findIndex(r => r.id == id);
        if (idx === -1) return null;
        rows[idx] = { ...rows[idx], ...updates, updated_at: new Date().toISOString() };
        this._write(table, rows);
        return rows[idx];
    }

    delete(table, id) {
        const rows = this._read(table);
        const idx  = rows.findIndex(r => r.id == id);
        if (idx === -1) return null;
        const [deleted] = rows.splice(idx, 1);
        this._write(table, rows);
        return deleted;
    }

    count(table, filter = {}) {
        return this.find(table, filter).length;
    }
}

module.exports = FileDbService;
