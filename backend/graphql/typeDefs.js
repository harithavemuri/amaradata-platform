module.exports = `
  type Tenant {
    id: ID!
    name: String!
    slug: String!
    contact_name: String
    contact_email: String
    contact_phone: String
    status: String!
    onboarded_at: String
    site_url: String
    created_at: String
  }

  type InvoiceLineItem {
    id: ID!
    invoice_id: ID!
    billing_type: String
    description: String!
    quantity: Float
    unit_price: Float
    amount: Float!
    sort_order: Int
  }

  type Invoice {
    id: ID!
    invoice_number: String!
    tenant_id: ID!
    tenant_name: String
    period_year: Int
    period_month: Int
    issue_date: String!
    due_date: String!
    status: String!
    subtotal: Float
    tax_pct: Float
    tax_amount: Float
    total_amount: Float
    notes: String
    paid_at: String
    created_at: String
    line_items: [InvoiceLineItem]
  }

  type Enhancement {
    id: ID!
    tenant_id: ID!
    tenant_name: String
    title: String!
    description: String
    billing_type: String
    status: String!
    estimated_hours: Float
    hourly_rate: Float
    milestone_amount: Float
    invoice_id: ID
    notes: String
    created_at: String
  }

  type BillingMetric {
    id: ID!
    tenant_id: ID!
    tenant_name: String
    period_year: Int!
    period_month: Int!
    sales_count: Int
    sales_value: Float
    rental_units: Int
    rental_income: Float
    active_properties: Int
    collected_at: String
  }

  type SubscriptionPlan {
    id: ID!
    name: String!
    description: String
    sales_pct: Float
    rental_pct: Float
    hourly_rate: Float
    min_monthly_fee: Float
    currency_code: String
    is_active: Boolean
  }

  type TenantSubscription {
    id: ID!
    tenant_id: ID!
    tenant_name: String
    plan_id: ID!
    plan_name: String
    effective_from: String
    effective_to: String
    custom_sales_pct: Float
    custom_rental_pct: Float
    custom_hourly_rate: Float
  }

  type Query {
    tenants(status: String): [Tenant]!
    tenant(id: ID!): Tenant
    invoices(tenant_id: ID, status: String): [Invoice]!
    invoice(id: ID!): Invoice
    enhancements(tenant_id: ID, status: String): [Enhancement]!
    billingMetrics(tenant_id: ID, year: Int, month: Int): [BillingMetric]!
    subscriptionPlans: [SubscriptionPlan]!
    subscriptions(tenant_id: ID): [TenantSubscription]!
  }
`;
