-- AmaraData Platform Database
-- Run against a dedicated PostgreSQL database: amaradata_platform

-- Migration history — one row per named migration; version is the primary key so re-runs are safe.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     VARCHAR(50)  PRIMARY KEY,
    description TEXT,
    applied_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Internal AmaraData staff users
-- Roles: site_admin | admin | sales_manager | billing | staff
CREATE TABLE IF NOT EXISTS amr_users (
    id              SERIAL PRIMARY KEY,
    username        VARCHAR(255) UNIQUE NOT NULL,
    email           VARCHAR(255) NOT NULL,
    name            VARCHAR(255) NOT NULL,
    first_name      VARCHAR(100),
    last_name       VARCHAR(100),
    role            VARCHAR(50)  NOT NULL DEFAULT 'staff',
    password_hash   TEXT         NOT NULL DEFAULT '',
    google_id       VARCHAR(255),
    logo_url        VARCHAR(500),
    is_active       BOOLEAN      NOT NULL DEFAULT true,
    last_login_at   TIMESTAMP,
    created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Backward-compat migration: add username to existing tables, default to email
ALTER TABLE amr_users ADD COLUMN IF NOT EXISTS username VARCHAR(255);
UPDATE amr_users SET username = email WHERE username IS NULL OR username = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON amr_users(username);
ALTER TABLE amr_users ALTER COLUMN username SET NOT NULL;
ALTER TABLE amr_users DROP CONSTRAINT IF EXISTS amr_users_email_key;

-- Canonical platform roles — one source of truth for valid role names
-- is_system=true roles cannot be deleted (only descriptions can be edited).
CREATE TABLE IF NOT EXISTS amr_roles (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(50) UNIQUE NOT NULL,   -- matches amr_users.role
    label       VARCHAR(100) NOT NULL,
    description TEXT,
    is_system   BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO amr_roles (name, label, description, is_system) VALUES
    ('site_admin',    'Site Admin',    'Full platform access including user and role management', true),
    ('admin',         'Admin',         'Tenant, invoice and enhancement management', true),
    ('sales_manager', 'Sales Manager', 'View and manage tenant sales pipeline', true),
    ('billing',       'Billing',       'Access to invoices and payments', true),
    ('staff',         'Staff',         'Basic read-only platform access', true)
ON CONFLICT (name) DO NOTHING;

-- Migration: rename old amr_user_groups / amr_user_group_members → new names and add FK columns.
-- Must run BEFORE the CREATE TABLE IF NOT EXISTS below so that renames happen first on existing DBs.
-- Safe to re-run; every step is guarded by IF EXISTS / IF NOT EXISTS.
DO $$
BEGIN
    -- Rename old tables if they exist under the old names and the new names don't exist yet
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'amr_user_groups')
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'amr_groups') THEN
        ALTER TABLE amr_user_groups RENAME TO amr_groups;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'amr_user_group_members')
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'amr_group_members') THEN
        ALTER TABLE amr_user_group_members RENAME TO amr_group_members;
    END IF;

    -- Create indexes if missing
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_gm_group') THEN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'amr_group_members') THEN
            CREATE INDEX idx_gm_group ON amr_group_members(group_id);
        END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_gm_user') THEN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'amr_group_members') THEN
            CREATE INDEX idx_gm_user ON amr_group_members(user_id);
        END IF;
    END IF;
END $$;

-- Groups — platform staff grouped by function (e.g. "Sales Team", "Billing Team").
-- Tenant + role assignments live in the group_tenant join table (mirrors rohas-group pattern).
CREATE TABLE IF NOT EXISTS amr_groups (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Many-to-many: user ↔ group membership
CREATE TABLE IF NOT EXISTS amr_group_members (
    id          SERIAL PRIMARY KEY,
    group_id    INTEGER   NOT NULL REFERENCES amr_groups(id) ON DELETE CASCADE,
    user_id     INTEGER   NOT NULL REFERENCES amr_users(id)  ON DELETE CASCADE,
    assigned_at TIMESTAMP NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_gm_group ON amr_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_gm_user  ON amr_group_members(user_id);

-- Group → tenant + role assignments (mirrors rohas-group's group_project table).
-- A group can have different roles across different tenant projects.
CREATE TABLE IF NOT EXISTS group_tenant (
    id          SERIAL    PRIMARY KEY,
    group_id    INTEGER   NOT NULL REFERENCES amr_groups(id) ON DELETE CASCADE,
    tenant_id   INTEGER   NOT NULL REFERENCES tenants(id)    ON DELETE CASCADE,
    role_id     INTEGER   NOT NULL REFERENCES amr_roles(id)  ON DELETE CASCADE,
    assigned_at TIMESTAMP NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (group_id, tenant_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_gt_group  ON group_tenant(group_id);
CREATE INDEX IF NOT EXISTS idx_gt_tenant ON group_tenant(tenant_id);

-- Tenants (one row per customer, e.g. "Rohas Group")
CREATE TABLE IF NOT EXISTS tenants (
    id                    SERIAL PRIMARY KEY,
    name                  VARCHAR(255) NOT NULL,          -- display name
    slug                  VARCHAR(100) UNIQUE NOT NULL,   -- e.g. "rohas"
    currency_code         VARCHAR(3)   NOT NULL DEFAULT 'INR',
    contact_name          VARCHAR(255),
    contact_email         VARCHAR(255),
    contact_phone         VARCHAR(50),
    billing_address       TEXT,
    gstin                 VARCHAR(20),
    pan                   VARCHAR(20),
    status                VARCHAR(50)  NOT NULL DEFAULT 'active', -- active | suspended | churned
    -- Connection info to the tenant's own operational DB (read-only for metrics collection).
    -- Credentials are stored in AWS Secrets Manager; tenant_db_secret_arn is the reference.
    tenant_db_host        VARCHAR(255),
    tenant_db_port        INTEGER      DEFAULT 5432,
    tenant_db_name        VARCHAR(100),
    tenant_db_user        VARCHAR(100),
    tenant_db_secret_arn  VARCHAR(500),                  -- AWS Secrets Manager ARN for DB password (production)
    tenant_db_password    TEXT,                          -- DB password for local dev only; use Secrets Manager in production
    onboarded_at          DATE,
    notes                 TEXT,
    site_url              VARCHAR(500),                          -- tenant's application URL (hosted/managed by AmaraData)
    created_at            TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Reusable plan definitions
CREATE TABLE IF NOT EXISTS subscription_plans (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    sales_pct       NUMERIC(5,2) NOT NULL DEFAULT 0,    -- % of property sale value
    rental_pct      NUMERIC(5,2) NOT NULL DEFAULT 0,    -- % of monthly rental income collected
    hourly_rate     NUMERIC(10,2) NOT NULL DEFAULT 0,   -- rate for enhancement work
    min_monthly_fee NUMERIC(10,2) NOT NULL DEFAULT 0,   -- floor charge per month
    currency_code   CHAR(3)       NOT NULL DEFAULT 'INR',
    is_active       BOOLEAN       NOT NULL DEFAULT true,
    created_at      TIMESTAMP     NOT NULL DEFAULT NOW()
);

-- Which plan a tenant is on (history preserved via effective_to)
CREATE TABLE IF NOT EXISTS tenant_subscriptions (
    id                  SERIAL PRIMARY KEY,
    tenant_id           INTEGER      NOT NULL REFERENCES tenants(id),
    plan_id             INTEGER      NOT NULL REFERENCES subscription_plans(id),
    effective_from      DATE         NOT NULL,
    effective_to        DATE,                            -- NULL = still active
    -- Per-tenant negotiated overrides (NULL = use plan defaults)
    custom_sales_pct    NUMERIC(5,2),
    custom_rental_pct   NUMERIC(5,2),
    custom_hourly_rate  NUMERIC(10,2),
    custom_min_fee      NUMERIC(10,2),
    notes               TEXT,
    created_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Monthly usage snapshots pulled from each tenant DB
CREATE TABLE IF NOT EXISTS billing_metrics (
    id                  SERIAL PRIMARY KEY,
    tenant_id           INTEGER      NOT NULL REFERENCES tenants(id),
    subscription_id     INTEGER      REFERENCES tenant_subscriptions(id), -- plan active at collection time
    period_year         INTEGER      NOT NULL,
    period_month        INTEGER      NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    sales_count         INTEGER      NOT NULL DEFAULT 0,
    sales_value         NUMERIC(15,2) NOT NULL DEFAULT 0,  -- sum of sale prices (properties sold)
    rental_units        INTEGER      NOT NULL DEFAULT 0,
    rental_income       NUMERIC(15,2) NOT NULL DEFAULT 0,  -- sum of rent_payments collected
    active_properties   INTEGER      NOT NULL DEFAULT 0,
    collected_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, period_year, period_month)
);

-- Invoices issued to tenants
CREATE TABLE IF NOT EXISTS invoices (
    id              SERIAL PRIMARY KEY,
    invoice_number  VARCHAR(50)   UNIQUE NOT NULL,  -- e.g. AMR-2026-0001
    tenant_id       INTEGER       NOT NULL REFERENCES tenants(id),
    period_year     INTEGER,
    period_month    INTEGER       CHECK (period_month BETWEEN 1 AND 12),
    issue_date      DATE          NOT NULL,
    due_date        DATE          NOT NULL,
    status          VARCHAR(50)   NOT NULL DEFAULT 'draft', -- draft | sent | paid | overdue | cancelled
    CONSTRAINT period_both_or_neither CHECK (
        (period_year IS NULL) = (period_month IS NULL)
    ),
    subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
    tax_pct         NUMERIC(5,2)  NOT NULL DEFAULT 18,      -- GST %
    tax_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
    currency_code   CHAR(3)       NOT NULL DEFAULT 'INR',
    notes           TEXT,
    paid_at         TIMESTAMP,
    created_by      INTEGER       REFERENCES amr_users(id),
    created_at      TIMESTAMP     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP     NOT NULL DEFAULT NOW()
);

-- Line items within an invoice
CREATE TABLE IF NOT EXISTS invoice_line_items (
    id              SERIAL PRIMARY KEY,
    invoice_id      INTEGER       NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    billing_type    VARCHAR(50)   NOT NULL, -- sales_pct | rental_pct | hourly | milestone | fixed
    description     TEXT          NOT NULL,
    quantity        NUMERIC(10,2) NOT NULL DEFAULT 1,
    unit_price      NUMERIC(12,2) NOT NULL DEFAULT 0,
    amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
    sort_order      INTEGER       NOT NULL DEFAULT 0
);

-- Custom enhancement / project work tracked per tenant
CREATE TABLE IF NOT EXISTS enhancements (
    id                SERIAL PRIMARY KEY,
    tenant_id         INTEGER       NOT NULL REFERENCES tenants(id),
    title             VARCHAR(255)  NOT NULL,
    description       TEXT,
    billing_type      VARCHAR(50)   NOT NULL DEFAULT 'hourly', -- hourly | milestone | fixed
    status            VARCHAR(50)   NOT NULL DEFAULT 'scoped',  -- scoped | in_progress | delivered | billed | cancelled
    estimated_hours   NUMERIC(7,2),
    actual_hours      NUMERIC(7,2),
    hourly_rate       NUMERIC(10,2),
    milestone_amount  NUMERIC(12,2),                           -- for milestone/fixed billing
    delivered_at      DATE,
    invoice_id        INTEGER       REFERENCES invoices(id),   -- set once billed
    notes             TEXT,
    -- CSV import fields (source='csv' rows come from RohasTestNotesSheet_Fixed.csv)
    source            VARCHAR(20)   NOT NULL DEFAULT 'manual', -- 'manual' | 'csv'
    issue_id          BIGINT,
    site_name         VARCHAR(100),
    fixed             VARCHAR(200),
    item_type         VARCHAR(50)   NOT NULL DEFAULT 'enhancement', -- 'bug' | 'enhancement'
    is_billable       BOOLEAN       NOT NULL DEFAULT true,
    report_date       DATE,
    created_at        TIMESTAMP     NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMP     NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, issue_id)  -- NULLs are not considered equal, so manual rows are unaffected
);

-- Payment receipts against invoices
CREATE TABLE IF NOT EXISTS payments (
    id               SERIAL PRIMARY KEY,
    invoice_id       INTEGER       NOT NULL REFERENCES invoices(id),
    tenant_id        INTEGER       NOT NULL REFERENCES tenants(id),
    amount           NUMERIC(12,2) NOT NULL,
    payment_date     DATE          NOT NULL,
    payment_method   VARCHAR(50),  -- bank_transfer | upi | cheque | other
    reference_number VARCHAR(100),
    notes            TEXT,
    recorded_by      INTEGER       REFERENCES amr_users(id),
    created_at       TIMESTAMP     NOT NULL DEFAULT NOW(),
    -- Prevent duplicate payment recording for the same bank reference per tenant
    UNIQUE (tenant_id, reference_number)
);

-- Contact form submissions
CREATE TABLE IF NOT EXISTS contact_submissions (
    id              SERIAL PRIMARY KEY,
    ref_number      VARCHAR(30)  UNIQUE NOT NULL,
    name            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL,
    phone           VARCHAR(50),
    company         VARCHAR(255),
    message         TEXT         NOT NULL,
    status          VARCHAR(50)  NOT NULL DEFAULT 'new', -- new | contacted | resolved
    submitted_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Password reset tokens (one active token per user, 1-hour TTL)
CREATE TABLE IF NOT EXISTS amr_password_reset_tokens (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES amr_users(id) ON DELETE CASCADE,
    token      VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prt_token ON amr_password_reset_tokens(token);

-- Per-user email folders (custom + a per-user Trash) — emails themselves live in
-- S3 (see backend/routes/email.js), identified by their S3 object key. An email
-- with no row in email_placements for a given user is implicitly in that user's
-- Inbox — only explicit moves (including to Trash) get a row.
CREATE TABLE IF NOT EXISTS email_folders (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER      NOT NULL REFERENCES amr_users(id) ON DELETE CASCADE,
    name       VARCHAR(100) NOT NULL,
    is_trash   BOOLEAN      NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS email_placements (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER      NOT NULL REFERENCES amr_users(id) ON DELETE CASCADE,
    email_id   VARCHAR(500) NOT NULL,
    folder_id  INTEGER      REFERENCES email_folders(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, email_id)
);

CREATE INDEX IF NOT EXISTS idx_email_folders_user      ON email_folders(user_id);
CREATE INDEX IF NOT EXISTS idx_email_placements_user   ON email_placements(user_id);
CREATE INDEX IF NOT EXISTS idx_email_placements_folder ON email_placements(folder_id);

-- issue_fixes retired — issue fix data is now stored in enhancements (source='csv')

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bm_tenant_period     ON billing_metrics(tenant_id, period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant       ON invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status       ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_enhancements_tenant   ON enhancements(tenant_id);
CREATE INDEX IF NOT EXISTS idx_enhancements_status   ON enhancements(status);
CREATE INDEX IF NOT EXISTS idx_payments_invoice      ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_tsub_tenant           ON tenant_subscriptions(tenant_id);
-- Prevent a tenant from having two active subscriptions simultaneously
CREATE UNIQUE INDEX IF NOT EXISTS idx_tsub_one_active ON tenant_subscriptions(tenant_id) WHERE effective_to IS NULL;

-- ── Migration 2026.06.11.003: Align structure with rohas-group pattern ──────────
DO $$
BEGIN
    -- amr_users: add profile columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amr_users' AND column_name='first_name') THEN
        ALTER TABLE amr_users ADD COLUMN first_name  VARCHAR(100);
        ALTER TABLE amr_users ADD COLUMN last_name   VARCHAR(100);
        ALTER TABLE amr_users ADD COLUMN logo_url    VARCHAR(500);
        UPDATE amr_users SET
            first_name = TRIM(SPLIT_PART(TRIM(name), ' ', 1)),
            last_name  = NULLIF(TRIM(SUBSTRING(TRIM(name) FROM POSITION(' ' IN TRIM(name)) + 1)), ''),
            logo_url   = picture;
    END IF;

    -- tenants: add currency_code
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tenants' AND column_name='currency_code') THEN
        ALTER TABLE tenants ADD COLUMN currency_code VARCHAR(3) NOT NULL DEFAULT 'INR';
        UPDATE tenants SET currency_code = 'INR';
    END IF;

    -- amr_groups: migrate existing role+tenant assignments to group_tenant, then drop columns
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amr_groups' AND column_name='role_id') THEN
        -- Create group_tenant first if it doesn't exist yet (may arrive here before the CREATE TABLE above runs on re-run)
        -- (group_tenant is created by CREATE TABLE IF NOT EXISTS above, but the DO block runs in same transaction)
        INSERT INTO group_tenant (group_id, tenant_id, role_id, assigned_at, created_at, updated_at)
        SELECT g.id, g.tenant_id, g.role_id, g.created_at, g.created_at, g.updated_at
        FROM amr_groups g
        WHERE g.tenant_id IS NOT NULL AND g.role_id IS NOT NULL
        ON CONFLICT (group_id, tenant_id, role_id) DO NOTHING;

        ALTER TABLE amr_groups DROP COLUMN IF EXISTS role_id;
        ALTER TABLE amr_groups DROP COLUMN IF EXISTS tenant_id;
        ALTER TABLE amr_groups DROP COLUMN IF EXISTS created_by;
    END IF;

    -- amr_groups: add UNIQUE constraint on name if missing
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'amr_groups_name_key' OR conname = 'amr_groups_name_unique') THEN
        -- Deduplicate: keep only the lowest id for each name
        DELETE FROM amr_group_members WHERE group_id IN (
            SELECT id FROM amr_groups WHERE id NOT IN (
                SELECT MIN(id) FROM amr_groups GROUP BY lower(name)
            )
        );
        DELETE FROM amr_groups WHERE id NOT IN (
            SELECT MIN(id) FROM amr_groups GROUP BY lower(name)
        );
        ALTER TABLE amr_groups ADD CONSTRAINT amr_groups_name_key UNIQUE (name);
    END IF;

    -- amr_group_members: drop tenant_id, rename added_at → assigned_at, add created_at
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amr_group_members' AND column_name='tenant_id') THEN
        ALTER TABLE amr_group_members DROP COLUMN tenant_id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amr_group_members' AND column_name='added_at')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amr_group_members' AND column_name='assigned_at') THEN
        ALTER TABLE amr_group_members RENAME COLUMN added_at TO assigned_at;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amr_group_members' AND column_name='created_at') THEN
        ALTER TABLE amr_group_members ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT NOW();
        UPDATE amr_group_members SET created_at = assigned_at;
    END IF;
END $$;

-- ── Migration 2026.06.12.001: Drop unused columns ────────────────────────────
DO $$
BEGIN
    ALTER TABLE amr_users DROP COLUMN IF EXISTS picture;
    ALTER TABLE amr_users DROP COLUMN IF EXISTS locale;
    ALTER TABLE amr_users DROP COLUMN IF EXISTS region_code;
    ALTER TABLE tenants   DROP COLUMN IF EXISTS description;
    ALTER TABLE tenants   DROP COLUMN IF EXISTS logo_url;
    ALTER TABLE tenants   DROP COLUMN IF EXISTS region_code;
END $$;

-- Sequence sync: reset all SERIAL sequences to MAX(id)+1 to fix drift after bulk JSON imports.
-- Safe to run on every migration — setval is idempotent when data hasn't changed.
SELECT setval('amr_users_id_seq',                 COALESCE((SELECT MAX(id) FROM amr_users), 0) + 1, false);
SELECT setval('amr_roles_id_seq',                 COALESCE((SELECT MAX(id) FROM amr_roles), 0) + 1, false);
-- Sequence name depends on whether table was created fresh (amr_groups_id_seq) or renamed from old table
-- (amr_user_groups_id_seq). Use pg_get_serial_sequence to resolve the correct name safely.
DO $$
BEGIN
    EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(id) FROM amr_groups), 0) + 1, false)',
        pg_get_serial_sequence('amr_groups', 'id'));
    EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(id) FROM amr_group_members), 0) + 1, false)',
        pg_get_serial_sequence('amr_group_members', 'id'));
END $$;
SELECT setval('tenants_id_seq',                    COALESCE((SELECT MAX(id) FROM tenants), 0) + 1, false);
SELECT setval('tenant_subscriptions_id_seq',       COALESCE((SELECT MAX(id) FROM tenant_subscriptions), 0) + 1, false);
SELECT setval('subscription_plans_id_seq',         COALESCE((SELECT MAX(id) FROM subscription_plans), 0) + 1, false);
SELECT setval('invoices_id_seq',                   COALESCE((SELECT MAX(id) FROM invoices), 0) + 1, false);
SELECT setval('invoice_line_items_id_seq',         COALESCE((SELECT MAX(id) FROM invoice_line_items), 0) + 1, false);
SELECT setval('billing_metrics_id_seq',            COALESCE((SELECT MAX(id) FROM billing_metrics), 0) + 1, false);
SELECT setval('enhancements_id_seq',               COALESCE((SELECT MAX(id) FROM enhancements), 0) + 1, false);
SELECT setval('payments_id_seq',                   COALESCE((SELECT MAX(id) FROM payments), 0) + 1, false);
SELECT setval('contact_submissions_id_seq',        COALESCE((SELECT MAX(id) FROM contact_submissions), 0) + 1, false);
SELECT setval('amr_password_reset_tokens_id_seq',  COALESCE((SELECT MAX(id) FROM amr_password_reset_tokens), 0) + 1, false);
SELECT setval('group_tenant_id_seq',               COALESCE((SELECT MAX(id) FROM group_tenant), 0) + 1, false);
SELECT setval('email_folders_id_seq',              COALESCE((SELECT MAX(id) FROM email_folders), 0) + 1, false);
SELECT setval('email_placements_id_seq',           COALESCE((SELECT MAX(id) FROM email_placements), 0) + 1, false);

-- Seed: default plan
INSERT INTO subscription_plans (name, description, sales_pct, rental_pct, hourly_rate, min_monthly_fee)
VALUES ('Standard', 'Default plan — 1% of sales, 2% of rental income, ₹2000/hr enhancements', 1.00, 2.00, 2000.00, 0)
ON CONFLICT DO NOTHING;

-- Seed: smoke-test service accounts (password: ez3Find@@123, bcrypt rounds=12)
-- UPDATE resets to known password if user already exists; conditional INSERT creates if absent.
UPDATE amr_users
SET password_hash = '$2a$12$FQbKNm5AlKLsMC8VNc1BcegcIu8p9djZaeFAhYB2lEopCY7ruaFi.',
    role = 'site_admin', is_active = true, updated_at = NOW()
WHERE username = 'smoketest.admin';

INSERT INTO amr_users (username, email, name, role, password_hash, is_active)
SELECT 'smoketest.admin', 'harithavemuri@gmail.com', 'Smoke Test Admin', 'site_admin',
       '$2a$12$FQbKNm5AlKLsMC8VNc1BcegcIu8p9djZaeFAhYB2lEopCY7ruaFi.', true
WHERE NOT EXISTS (SELECT 1 FROM amr_users WHERE username = 'smoketest.admin');

UPDATE amr_users
SET password_hash = '$2a$12$FQbKNm5AlKLsMC8VNc1BcegcIu8p9djZaeFAhYB2lEopCY7ruaFi.',
    email = 'smoketest.salesperson@amaradata.com',
    role = 'sales_manager', is_active = true, updated_at = NOW()
WHERE username = 'smoketest.salesperson';

INSERT INTO amr_users (username, email, name, role, password_hash, is_active)
SELECT 'smoketest.salesperson', 'smoketest.salesperson@amaradata.com', 'Smoke Test Sales Person', 'sales_manager',
       '$2a$12$FQbKNm5AlKLsMC8VNc1BcegcIu8p9djZaeFAhYB2lEopCY7ruaFi.', true
WHERE NOT EXISTS (SELECT 1 FROM amr_users WHERE username = 'smoketest.salesperson');

-- Migration versions — add a new row for each deploy that changes the schema.
-- ON CONFLICT DO NOTHING makes re-runs safe; applied_at reflects first application.
INSERT INTO schema_migrations (version, description) VALUES
    ('2026.06.10.001', 'Username-based auth, sequence sync, smoketest users, schema_migrations table'),
    ('2026.06.11.001', 'Rename amr_user_groups→amr_groups, amr_user_group_members→amr_group_members; add tenant_id + role_id FK'),
    ('2026.06.11.002', 'Add tenant_id to amr_group_members for direct per-tenant access lookup'),
    ('2026.06.11.003', 'Align with rohas-group: user profile cols, tenant profile cols, group_tenant table, drop role_id/tenant_id/created_by from groups, assigned_at+created_at on group_members'),
    ('2026.06.12.001', 'Drop unused columns: amr_users.picture/locale/region_code, tenants.description/logo_url/region_code'),
    ('2026.08.01.001', 'Add email_folders and email_placements for per-user email folders/trash')
ON CONFLICT (version) DO NOTHING;
