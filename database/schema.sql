-- AmaraData Platform Database
-- Run against a dedicated PostgreSQL database: amaradata_platform

-- Internal AmaraData staff users
CREATE TABLE IF NOT EXISTS amr_users (
    id              SERIAL PRIMARY KEY,
    email           VARCHAR(255) UNIQUE NOT NULL,
    name            VARCHAR(255) NOT NULL,
    role            VARCHAR(50)  NOT NULL DEFAULT 'staff', -- admin | staff | billing
    password_hash   TEXT         NOT NULL DEFAULT '',
    google_id       VARCHAR(255),
    picture         TEXT,
    is_active       BOOLEAN      NOT NULL DEFAULT true,
    last_login_at   TIMESTAMP,
    created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Tenants (one row per customer, e.g. "Rohas Group")
CREATE TABLE IF NOT EXISTS tenants (
    id                    SERIAL PRIMARY KEY,
    name                  VARCHAR(255) NOT NULL,          -- display name
    slug                  VARCHAR(100) UNIQUE NOT NULL,   -- e.g. "rohas"
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
    created_at        TIMESTAMP     NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMP     NOT NULL DEFAULT NOW()
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

-- Seed: default plan
INSERT INTO subscription_plans (name, description, sales_pct, rental_pct, hourly_rate, min_monthly_fee)
VALUES ('Standard', 'Default plan — 1% of sales, 2% of rental income, ₹2000/hr enhancements', 1.00, 2.00, 2000.00, 0)
ON CONFLICT DO NOTHING;
