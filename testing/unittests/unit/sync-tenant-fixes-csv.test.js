// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    splitCsvLine,
    normalizeHeader,
    parseCsv,
    extractEligibleRows,
    groupByTenant,
} from '../../../jobs/sync-tenant-fixes.js';

describe('sync-tenant-fixes CSV parsing (pure, no filesystem/DB)', () => {
    describe('splitCsvLine', () => {
        it('splits a plain comma-separated line', () => {
            expect(splitCsvLine('1,2,3')).toEqual(['1', '2', '3']);
        });

        it('keeps a comma inside a quoted field as part of that field', () => {
            expect(splitCsvLine('1,"a, b, c",3')).toEqual(['1', 'a, b, c', '3']);
        });

        it('handles a trailing empty field', () => {
            expect(splitCsvLine('1,2,')).toEqual(['1', '2', '']);
        });
    });

    describe('normalizeHeader', () => {
        it('lowercases and collapses whitespace/? runs to a single underscore', () => {
            expect(normalizeHeader('IssueId')).toBe('issueid');
            expect(normalizeHeader('Report Date')).toBe('report_date');
            expect(normalizeHeader('Apply Fix?')).toBe('apply_fix_');
            expect(normalizeHeader('Fixed?')).toBe('fixed_');
        });
    });

    describe('parseCsv', () => {
        const csv =
            'IssueId,Report Date,Notes,Site Name,Tenant Name,Apply Fix?,Fixed?,Fix Details,Type,Billable\n' +
            '1,May 28 2026,"Notes, with a comma",rohas-group,Rohas Group,Yes,Yes,"Fixed it, done",Enhancement,Yes\n' +
            '\n' + // blank line should be skipped
            '2,May 26 2026,Plain notes,rohas-group,Rohas Group,No,No,,Bug,No\n';

        it('parses rows keyed by normalized header, skipping blank lines', () => {
            const rows = parseCsv(csv);
            expect(rows).toHaveLength(2);
            expect(rows[0].issueid).toBe('1');
            expect(rows[0].notes).toBe('Notes, with a comma');
            expect(rows[0].fix_details).toBe('Fixed it, done');
            expect(rows[1].apply_fix_).toBe('No');
        });
    });

    describe('extractEligibleRows', () => {
        const parsed = parseCsv(
            'IssueId,Report Date,Notes,Site Name,Tenant Name,Apply Fix?,Fixed?,Fix Details,Type,Billable\n' +
            '1,May 28 2026,Enhancement work,rohas-group,Rohas Group,Yes,Yes,Shipped it,Enhancement,Yes\n' +
            '2,May 28 2026,A task,rohas-group,Rohas Group,Yes,Yes,Shipped it,Task,No\n' +
            '3,May 28 2026,A bug,rohas-group,Rohas Group,Yes,Yes,Fixed it,Bug,No\n' +
            '4,May 28 2026,Deferred item,rohas-group,Rohas Group,No,No,,Bug,No\n' +
            '5,May 28 2026,No issue id,rohas-group,Rohas Group,Yes,Yes,,Bug,No\n'
        );
        // Row 5 has no IssueId (blank) — simulate by stripping it after parse
        parsed[4].issueid = '';

        const eligible = extractEligibleRows(parsed);

        it('excludes rows where Apply Fix? is not Yes', () => {
            expect(eligible.find(r => r.issue_id === 4)).toBeUndefined();
        });

        it('excludes rows with no issue_id even if Apply Fix?=Yes', () => {
            expect(eligible).toHaveLength(3); // 1, 2, 3 — not 4 (apply_fix=No) or 5 (no issue_id)
        });

        it('normalizes Type=Task to item_type=enhancement (never a raw "task" value)', () => {
            const task = eligible.find(r => r.issue_id === 2);
            expect(task.item_type).toBe('enhancement');
        });

        it('keeps Type=Enhancement as enhancement and Type=Bug as bug', () => {
            expect(eligible.find(r => r.issue_id === 1).item_type).toBe('enhancement');
            expect(eligible.find(r => r.issue_id === 3).item_type).toBe('bug');
        });

        it('trusts the CSV Billable column verbatim (Yes -> true, No -> false)', () => {
            expect(eligible.find(r => r.issue_id === 1).is_billable).toBe(true);
            expect(eligible.find(r => r.issue_id === 2).is_billable).toBe(false); // Task marked non-billable in sheet
            expect(eligible.find(r => r.issue_id === 3).is_billable).toBe(false);
        });
    });

    describe('groupByTenant', () => {
        it('groups rows by tenant_name', () => {
            const rows = [
                { issue_id: 1, tenant_name: 'Rohas Group' },
                { issue_id: 2, tenant_name: 'Rohas Group' },
                { issue_id: 3, tenant_name: 'Acme Co' },
            ];
            const groups = groupByTenant(rows);
            expect(Object.keys(groups).sort()).toEqual(['Acme Co', 'Rohas Group']);
            expect(groups['Rohas Group']).toHaveLength(2);
        });

        it('buckets rows with no tenant_name under __unmatched__', () => {
            const groups = groupByTenant([{ issue_id: 9, tenant_name: null }]);
            expect(groups.__unmatched__).toHaveLength(1);
        });
    });
});
