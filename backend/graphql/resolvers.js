const { readPool } = require('../db');

module.exports = {
    tenants: async ({ status }, { db }) => {
        if (db.mode === 'nondb') {
            let rows = db.fileDb.find('tenants');
            if (status) rows = rows.filter(r => r.status === status);
            return rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        }
        const cols = 'id,name,slug,contact_name,contact_email,contact_phone,status,onboarded_at,site_url,created_at';
        let sql = `SELECT ${cols} FROM tenants WHERE 1=1`;
        const params = [];
        if (status) { sql += ' AND status=$1'; params.push(status); }
        sql += ' ORDER BY name';
        const { rows } = await readPool.query(sql, params);
        return rows;
    },

    tenant: async ({ id }, { db }) => {
        if (db.mode === 'nondb') return db.fileDb.getById('tenants', id);
        const cols = 'id,name,slug,contact_name,contact_email,contact_phone,status,onboarded_at,site_url,created_at';
        const { rows } = await readPool.query(`SELECT ${cols} FROM tenants WHERE id=$1`, [id]);
        return rows[0] || null;
    },

    invoices: async ({ tenant_id, status }, { db }) => {
        if (db.mode === 'nondb') {
            const tMap = Object.fromEntries(db.fileDb.find('tenants').map(t => [t.id, t]));
            let rows = db.fileDb.find('invoices');
            if (tenant_id) rows = rows.filter(r => r.tenant_id == tenant_id);
            if (status)    rows = rows.filter(r => r.status === status);
            return rows
                .map(r => ({ ...r, tenant_name: tMap[r.tenant_id]?.name }))
                .sort((a, b) => new Date(b.issue_date) - new Date(a.issue_date));
        }
        let sql = `SELECT i.*, t.name AS tenant_name
                   FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE 1=1`;
        const params = [];
        let n = 1;
        if (tenant_id) { sql += ` AND i.tenant_id=$${n++}`; params.push(tenant_id); }
        if (status)    { sql += ` AND i.status=$${n++}`;    params.push(status); }
        sql += ' ORDER BY i.issue_date DESC';
        const { rows } = await readPool.query(sql, params);
        return rows;
    },

    invoice: async ({ id }, { db }) => {
        if (db.mode === 'nondb') {
            const inv = db.fileDb.getById('invoices', id);
            if (!inv) return null;
            const t     = db.fileDb.getById('tenants', inv.tenant_id) || {};
            const items = db.fileDb.find('invoice_line_items')
                .filter(l => l.invoice_id == inv.id)
                .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
            return { ...inv, tenant_name: t.name, line_items: items };
        }
        const { rows: [inv] } = await readPool.query(
            `SELECT i.*, t.name AS tenant_name
             FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE i.id=$1`, [id]
        );
        if (!inv) return null;
        const { rows: items } = await readPool.query(
            'SELECT * FROM invoice_line_items WHERE invoice_id=$1 ORDER BY sort_order', [id]
        );
        return { ...inv, line_items: items };
    },

    enhancements: async ({ tenant_id, status }, { db }) => {
        if (db.mode === 'nondb') {
            const tMap = Object.fromEntries(db.fileDb.find('tenants').map(t => [t.id, t]));
            let rows = db.fileDb.find('enhancements');
            if (tenant_id) rows = rows.filter(r => r.tenant_id == tenant_id);
            if (status)    rows = rows.filter(r => r.status === status);
            return rows
                .map(r => ({ ...r, tenant_name: tMap[r.tenant_id]?.name }))
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        }
        let sql = `SELECT e.*, t.name AS tenant_name
                   FROM enhancements e JOIN tenants t ON t.id = e.tenant_id WHERE 1=1`;
        const params = [];
        let n = 1;
        if (tenant_id) { sql += ` AND e.tenant_id=$${n++}`; params.push(tenant_id); }
        if (status)    { sql += ` AND e.status=$${n++}`;    params.push(status); }
        sql += ' ORDER BY e.created_at DESC';
        const { rows } = await readPool.query(sql, params);
        return rows;
    },

    billingMetrics: async ({ tenant_id, year, month }, { db }) => {
        if (db.mode === 'nondb') {
            const tMap = Object.fromEntries(db.fileDb.find('tenants').map(t => [t.id, t]));
            let rows = db.fileDb.find('billing_metrics');
            if (tenant_id) rows = rows.filter(r => r.tenant_id == tenant_id);
            if (year)      rows = rows.filter(r => r.period_year == year);
            if (month)     rows = rows.filter(r => r.period_month == month);
            return rows
                .map(r => ({ ...r, tenant_name: tMap[r.tenant_id]?.name }))
                .sort((a, b) => b.period_year !== a.period_year
                    ? b.period_year - a.period_year
                    : b.period_month - a.period_month);
        }
        let sql = `SELECT m.*, t.name AS tenant_name
                   FROM billing_metrics m JOIN tenants t ON t.id = m.tenant_id WHERE 1=1`;
        const params = [];
        let n = 1;
        if (tenant_id) { sql += ` AND m.tenant_id=$${n++}`;   params.push(tenant_id); }
        if (year)      { sql += ` AND m.period_year=$${n++}`;  params.push(year); }
        if (month)     { sql += ` AND m.period_month=$${n++}`; params.push(month); }
        sql += ' ORDER BY m.period_year DESC, m.period_month DESC';
        const { rows } = await readPool.query(sql, params);
        return rows;
    },

    subscriptionPlans: async (_, { db }) => {
        if (db.mode === 'nondb') {
            return db.fileDb.find('subscription_plans')
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        }
        const { rows } = await readPool.query('SELECT * FROM subscription_plans ORDER BY name');
        return rows;
    },

    subscriptions: async ({ tenant_id }, { db }) => {
        if (db.mode === 'nondb') {
            const tMap = Object.fromEntries(db.fileDb.find('tenants').map(t => [t.id, t]));
            const pMap = Object.fromEntries(db.fileDb.find('subscription_plans').map(p => [p.id, p]));
            let rows = db.fileDb.find('tenant_subscriptions');
            if (tenant_id) rows = rows.filter(r => r.tenant_id == tenant_id);
            return rows
                .map(s => ({ ...s, tenant_name: tMap[s.tenant_id]?.name, plan_name: pMap[s.plan_id]?.name }))
                .sort((a, b) => new Date(b.effective_from) - new Date(a.effective_from));
        }
        let sql = `SELECT ts.*, t.name AS tenant_name, p.name AS plan_name
                   FROM tenant_subscriptions ts
                   JOIN tenants t ON t.id = ts.tenant_id
                   JOIN subscription_plans p ON p.id = ts.plan_id WHERE 1=1`;
        const params = [];
        if (tenant_id) { sql += ' AND ts.tenant_id=$1'; params.push(tenant_id); }
        sql += ' ORDER BY ts.effective_from DESC';
        const { rows } = await readPool.query(sql, params);
        return rows;
    },
};
