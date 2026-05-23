-- AmaraData Platform — Rohas Group Tenant Seed Data
-- Run after schema.sql has been applied.
-- Usage: psql -U postgres -d amaradata_platform -f database/seed_rohas.sql

-- ── Tenant ──────────────────────────────────────────────────────────────
INSERT INTO tenants (
    name, slug, contact_name, contact_email, contact_phone,
    billing_address, gstin, pan, status,
    tenant_db_host, tenant_db_port, tenant_db_name, tenant_db_user,
    tenant_db_password, onboarded_at, notes, site_url
) VALUES (
    'Rohas Group',
    'rohas',
    'Haritha Vemuri',
    'info@rohas.in',
    '+91-90328-31122',
    '#103, A Block, Fortune Nest Apartments, Near Jain Public School, Masjid Banda, Kondapur, Hyderabad, Telangana 500084, India',
    NULL,
    NULL,
    'active',
    'localhost',
    5432,
    'rohas',
    'postgress',
    NULL,           -- use AWS Secrets Manager in production; set tenant_db_secret_arn instead
    '2026-01-01',
    'Rohas Group real estate platform — managed by AmaraData. Tenant databases: amaracasa, towertwo.',
    'https://d3u4zlri3r48dr.cloudfront.net'
) ON CONFLICT (slug) DO NOTHING;

-- ── Subscription ────────────────────────────────────────────────────────
INSERT INTO tenant_subscriptions (
    tenant_id, plan_id, effective_from, effective_to,
    custom_sales_pct, custom_rental_pct, custom_hourly_rate, custom_min_fee, notes
) VALUES (
    (SELECT id FROM tenants WHERE slug = 'rohas'),
    (SELECT id FROM subscription_plans WHERE name = 'Standard'),
    '2026-01-01',
    NULL,
    NULL, NULL, NULL, NULL,
    'Standard plan from onboarding — 1% of sales, 2% of rental, ₹2,000/hr enhancements.'
) ON CONFLICT DO NOTHING;

-- ── Billing Metrics ──────────────────────────────────────────────────────
INSERT INTO billing_metrics (tenant_id, subscription_id, period_year, period_month, sales_count, sales_value, rental_units, rental_income, active_properties, collected_at)
SELECT t.id, ts.id, 2026, 1, 3, 24750000.00, 8, 192000.00, 45, '2026-02-01'
FROM tenants t JOIN tenant_subscriptions ts ON ts.tenant_id = t.id AND ts.effective_to IS NULL
WHERE t.slug = 'rohas'
ON CONFLICT (tenant_id, period_year, period_month) DO NOTHING;

INSERT INTO billing_metrics (tenant_id, subscription_id, period_year, period_month, sales_count, sales_value, rental_units, rental_income, active_properties, collected_at)
SELECT t.id, ts.id, 2026, 2, 2, 16500000.00, 9, 216000.00, 43, '2026-03-01'
FROM tenants t JOIN tenant_subscriptions ts ON ts.tenant_id = t.id AND ts.effective_to IS NULL
WHERE t.slug = 'rohas'
ON CONFLICT (tenant_id, period_year, period_month) DO NOTHING;

INSERT INTO billing_metrics (tenant_id, subscription_id, period_year, period_month, sales_count, sales_value, rental_units, rental_income, active_properties, collected_at)
SELECT t.id, ts.id, 2026, 3, 4, 32200000.00, 10, 240000.00, 41, '2026-04-01'
FROM tenants t JOIN tenant_subscriptions ts ON ts.tenant_id = t.id AND ts.effective_to IS NULL
WHERE t.slug = 'rohas'
ON CONFLICT (tenant_id, period_year, period_month) DO NOTHING;

INSERT INTO billing_metrics (tenant_id, subscription_id, period_year, period_month, sales_count, sales_value, rental_units, rental_income, active_properties, collected_at)
SELECT t.id, ts.id, 2026, 4, 3, 25600000.00, 10, 240000.00, 40, '2026-05-01'
FROM tenants t JOIN tenant_subscriptions ts ON ts.tenant_id = t.id AND ts.effective_to IS NULL
WHERE t.slug = 'rohas'
ON CONFLICT (tenant_id, period_year, period_month) DO NOTHING;

INSERT INTO billing_metrics (tenant_id, subscription_id, period_year, period_month, sales_count, sales_value, rental_units, rental_income, active_properties, collected_at)
SELECT t.id, ts.id, 2026, 5, 5, 41800000.00, 11, 264000.00, 42, '2026-05-21'
FROM tenants t JOIN tenant_subscriptions ts ON ts.tenant_id = t.id AND ts.effective_to IS NULL
WHERE t.slug = 'rohas'
ON CONFLICT (tenant_id, period_year, period_month) DO NOTHING;

-- ── Invoices ─────────────────────────────────────────────────────────────
INSERT INTO invoices (invoice_number, tenant_id, period_year, period_month, issue_date, due_date, status, subtotal, tax_pct, tax_amount, total_amount, currency_code, notes, paid_at, created_at, updated_at)
VALUES
  ('AMR-2026-0001', (SELECT id FROM tenants WHERE slug='rohas'), 2026, 1, '2026-02-01', '2026-02-15', 'paid',   251340.00, 18, 45241.20, 296581.20, 'INR', 'January 2026 — 3 sales, 8 rental units',                                        '2026-02-14 10:30:00', '2026-02-01 09:00:00', '2026-02-14 10:30:00'),
  ('AMR-2026-0002', (SELECT id FROM tenants WHERE slug='rohas'), 2026, 2, '2026-03-01', '2026-03-15', 'paid',   169320.00, 18, 30477.60, 199797.60, 'INR', 'February 2026 — 2 sales, 9 rental units',                                       '2026-03-12 14:15:00', '2026-03-01 09:00:00', '2026-03-12 14:15:00'),
  ('AMR-2026-0003', (SELECT id FROM tenants WHERE slug='rohas'), 2026, 3, '2026-04-01', '2026-04-15', 'paid',   350800.00, 18, 63144.00, 413944.00, 'INR', 'March 2026 — 4 sales, 10 rental units, Dashboard Analytics Upgrade enhancement', '2026-04-10 11:00:00', '2026-04-01 09:00:00', '2026-04-10 11:00:00'),
  ('AMR-2026-0004', (SELECT id FROM tenants WHERE slug='rohas'), 2026, 4, '2026-05-01', '2026-05-15', 'sent',   260800.00, 18, 46944.00, 307744.00, 'INR', 'April 2026 — 3 sales, 10 rental units',                                         NULL,                  '2026-05-01 09:00:00', '2026-05-01 09:00:00'),
  ('AMR-2026-0005', (SELECT id FROM tenants WHERE slug='rohas'), 2026, 5, '2026-06-01', '2026-06-15', 'draft',  423280.00, 18, 76190.40, 499470.40, 'INR', 'May 2026 — 5 sales, 11 rental units (draft, month in progress)',                  NULL,                  '2026-05-21 09:00:00', '2026-05-21 09:00:00')
ON CONFLICT (invoice_number) DO NOTHING;

-- ── Invoice Line Items ────────────────────────────────────────────────────
INSERT INTO invoice_line_items (invoice_id, billing_type, description, quantity, unit_price, amount, sort_order)
SELECT i.id, 'sales_pct',  'Sales Commission — January 2026 (3 transactions, 1% of ₹2,47,50,000)',    1,  247500.00, 247500.00, 1 FROM invoices i WHERE i.invoice_number = 'AMR-2026-0001';
INSERT INTO invoice_line_items (invoice_id, billing_type, description, quantity, unit_price, amount, sort_order)
SELECT i.id, 'rental_pct', 'Rental Income Commission — January 2026 (8 units, 2% of ₹1,92,000)',      1,    3840.00,   3840.00, 2 FROM invoices i WHERE i.invoice_number = 'AMR-2026-0001';

INSERT INTO invoice_line_items (invoice_id, billing_type, description, quantity, unit_price, amount, sort_order)
SELECT i.id, 'sales_pct',  'Sales Commission — February 2026 (2 transactions, 1% of ₹1,65,00,000)',   1,  165000.00, 165000.00, 1 FROM invoices i WHERE i.invoice_number = 'AMR-2026-0002';
INSERT INTO invoice_line_items (invoice_id, billing_type, description, quantity, unit_price, amount, sort_order)
SELECT i.id, 'rental_pct', 'Rental Income Commission — February 2026 (9 units, 2% of ₹2,16,000)',     1,    4320.00,   4320.00, 2 FROM invoices i WHERE i.invoice_number = 'AMR-2026-0002';

INSERT INTO invoice_line_items (invoice_id, billing_type, description, quantity, unit_price, amount, sort_order)
SELECT i.id, 'sales_pct',  'Sales Commission — March 2026 (4 transactions, 1% of ₹3,22,00,000)',      1,  322000.00, 322000.00, 1 FROM invoices i WHERE i.invoice_number = 'AMR-2026-0003';
INSERT INTO invoice_line_items (invoice_id, billing_type, description, quantity, unit_price, amount, sort_order)
SELECT i.id, 'rental_pct', 'Rental Income Commission — March 2026 (10 units, 2% of ₹2,40,000)',       1,    4800.00,   4800.00, 2 FROM invoices i WHERE i.invoice_number = 'AMR-2026-0003';
INSERT INTO invoice_line_items (invoice_id, billing_type, description, quantity, unit_price, amount, sort_order)
SELECT i.id, 'hourly',     'Enhancement: Dashboard Analytics Upgrade (12 hrs @ ₹2,000/hr)',            12,   2000.00,  24000.00, 3 FROM invoices i WHERE i.invoice_number = 'AMR-2026-0003';

INSERT INTO invoice_line_items (invoice_id, billing_type, description, quantity, unit_price, amount, sort_order)
SELECT i.id, 'sales_pct',  'Sales Commission — April 2026 (3 transactions, 1% of ₹2,56,00,000)',      1,  256000.00, 256000.00, 1 FROM invoices i WHERE i.invoice_number = 'AMR-2026-0004';
INSERT INTO invoice_line_items (invoice_id, billing_type, description, quantity, unit_price, amount, sort_order)
SELECT i.id, 'rental_pct', 'Rental Income Commission — April 2026 (10 units, 2% of ₹2,40,000)',       1,    4800.00,   4800.00, 2 FROM invoices i WHERE i.invoice_number = 'AMR-2026-0004';

INSERT INTO invoice_line_items (invoice_id, billing_type, description, quantity, unit_price, amount, sort_order)
SELECT i.id, 'sales_pct',  'Sales Commission — May 2026 (5 transactions, 1% of ₹4,18,00,000)',        1,  418000.00, 418000.00, 1 FROM invoices i WHERE i.invoice_number = 'AMR-2026-0005';
INSERT INTO invoice_line_items (invoice_id, billing_type, description, quantity, unit_price, amount, sort_order)
SELECT i.id, 'rental_pct', 'Rental Income Commission — May 2026 (11 units, 2% of ₹2,64,000)',         1,    5280.00,   5280.00, 2 FROM invoices i WHERE i.invoice_number = 'AMR-2026-0005';

-- ── Enhancements ──────────────────────────────────────────────────────────
INSERT INTO enhancements (tenant_id, title, description, billing_type, status, estimated_hours, actual_hours, hourly_rate, milestone_amount, delivered_at, invoice_id, notes, created_at, updated_at)
VALUES
  (
    (SELECT id FROM tenants WHERE slug='rohas'),
    'Dashboard Analytics Upgrade',
    'Enhanced the reporting dashboard with month-on-month sales trend charts, occupancy rate widgets, and top-performing property cards.',
    'hourly', 'billed', 10.00, 12.00, 2000.00, NULL, '2026-03-25',
    (SELECT id FROM invoices WHERE invoice_number='AMR-2026-0003'),
    'Billed in March 2026 invoice (AMR-2026-0003).',
    '2026-03-10 10:00:00', '2026-04-01 09:00:00'
  ),
  (
    (SELECT id FROM tenants WHERE slug='rohas'),
    'Lead Management CRM Module',
    'Build a dedicated lead pipeline view with stage tracking (New → Qualified → Closing → Won/Lost), follow-up reminders, and conversion rate reporting.',
    'hourly', 'in_progress', 24.00, 8.00, 2000.00, NULL, NULL, NULL,
    '8 hrs completed. Expected delivery: June 2026.',
    '2026-04-15 10:00:00', '2026-05-15 14:00:00'
  ),
  (
    (SELECT id FROM tenants WHERE slug='rohas'),
    'Bulk Property Import Tool',
    'CSV/Excel bulk import for property inventory with field mapping, duplicate detection, and validation preview before commit.',
    'milestone', 'scoped', NULL, NULL, NULL, 35000.00, NULL, NULL,
    'Scope agreed. Work begins June 2026.',
    '2026-05-10 10:00:00', '2026-05-10 10:00:00'
  ),
  (
    (SELECT id FROM tenants WHERE slug='rohas'),
    'Mobile App PWA Wrapper',
    'Progressive Web App configuration — service worker, offline cache, home-screen install prompt, and push notification scaffolding.',
    'hourly', 'delivered', 16.00, 18.00, 2000.00, NULL, '2026-05-10', NULL,
    'Delivered. To be billed in May 2026 invoice.',
    '2026-04-28 10:00:00', '2026-05-10 16:00:00'
  );

-- ── Payments ──────────────────────────────────────────────────────────────
INSERT INTO payments (invoice_id, tenant_id, amount, payment_date, payment_method, reference_number, notes, created_at)
VALUES
  ((SELECT id FROM invoices WHERE invoice_number='AMR-2026-0001'), (SELECT id FROM tenants WHERE slug='rohas'), 296581.20, '2026-02-14', 'bank_transfer', 'UTR2026021401', 'NEFT — Rohas Group → AmaraData. Invoice AMR-2026-0001.', '2026-02-14 10:30:00'),
  ((SELECT id FROM invoices WHERE invoice_number='AMR-2026-0002'), (SELECT id FROM tenants WHERE slug='rohas'), 199797.60, '2026-03-12', 'bank_transfer', 'UTR2026031201', 'NEFT — Rohas Group → AmaraData. Invoice AMR-2026-0002.', '2026-03-12 14:15:00'),
  ((SELECT id FROM invoices WHERE invoice_number='AMR-2026-0003'), (SELECT id FROM tenants WHERE slug='rohas'), 413944.00, '2026-04-10', 'bank_transfer', 'UTR2026041001', 'NEFT — Rohas Group → AmaraData. Invoice AMR-2026-0003 (includes enhancement).', '2026-04-10 11:00:00')
ON CONFLICT (tenant_id, reference_number) DO NOTHING;
