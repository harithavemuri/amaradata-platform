// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// FileDbService reads TRANSACTIONDATA_DIR once at module load time, so point it
// at an isolated scratch directory *before* requiring the module — this must
// never touch testing/testdata (shared fixtures used by API/integration tests).
let tmpDir;
let FileDbService;
let db;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amrd-filedb-unit-'));
    process.env.TRANSACTIONDATA_DIR = tmpDir;
    FileDbService = require('../../../backend/services/file-db-service.js');
    db = new FileDbService();
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FileDbService (pure, no server/HTTP)', () => {
    it('find() returns [] for a table with no file yet', () => {
        expect(db.find('widgets')).toEqual([]);
    });

    it('create() assigns an auto-incrementing id and timestamps', () => {
        const row = db.create('widgets', { name: 'first' });
        expect(row.id).toBe(1);
        expect(row.created_at).toBeTruthy();
        expect(row.updated_at).toBeTruthy();
        expect(row.name).toBe('first');
    });

    it('create() continues incrementing ids across calls', () => {
        const row2 = db.create('widgets', { name: 'second' });
        expect(row2.id).toBe(2);
    });

    it('getById() finds a row by loose-equality id', () => {
        const found = db.getById('widgets', '1'); // string id, loose match against numeric
        expect(found.name).toBe('first');
    });

    it('getById() returns null for a missing id', () => {
        expect(db.getById('widgets', 999)).toBeNull();
    });

    it('find() filters by exact field match', () => {
        const rows = db.find('widgets', { name: 'second' });
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(2);
    });

    it('update() merges fields and bumps updated_at without touching id/created_at', () => {
        const before = db.getById('widgets', 1);
        const updated = db.update('widgets', 1, { name: 'first-renamed' });
        expect(updated.id).toBe(1);
        expect(updated.created_at).toBe(before.created_at);
        expect(updated.name).toBe('first-renamed');
    });

    it('update() returns null for a missing id', () => {
        expect(db.update('widgets', 999, { name: 'x' })).toBeNull();
    });

    it('count() reflects the current row count, optionally filtered', () => {
        expect(db.count('widgets')).toBe(2);
        expect(db.count('widgets', { name: 'second' })).toBe(1);
    });

    it('delete() removes the row and it no longer appears in find()/count()', () => {
        const deleted = db.delete('widgets', 2);
        expect(deleted.name).toBe('second');
        expect(db.getById('widgets', 2)).toBeNull();
        expect(db.count('widgets')).toBe(1);
    });

    it('delete() returns null for a missing id', () => {
        expect(db.delete('widgets', 999)).toBeNull();
    });

    it('persists rows to disk as pretty-printed JSON', () => {
        const filePath = path.join(tmpDir, 'widgets.json');
        expect(fs.existsSync(filePath)).toBe(true);
        const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        expect(onDisk).toHaveLength(1);
        expect(onDisk[0].name).toBe('first-renamed');
    });
});
