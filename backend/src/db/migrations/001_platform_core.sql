-- A&A Creations platform — core schema shared by every tool.
--
-- Design: each new tool (Invoice Generator, Appointment Booking, ...) gets
-- its own migration + its own data tables, but ALL of them plug into this
-- same accounts/tools/tiers/subscriptions/usage engine instead of each tool
-- inventing its own billing logic. Adding tool #2 means: one row in `tools`,
-- one or two rows in `tool_tiers` describing its free/pro limits, and a new
-- migration for that tool's own tables — the account system, tier checks,
-- and Stripe checkout flow are already done.

CREATE TABLE users (
  id             SERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  company_name   TEXT,               -- shown on invoices / branded documents
  -- Platform-owner accounts (emails listed in OWNER_EMAILS) get this set on
  -- signup/login and bypass every tier limit on every tool for free — see
  -- services/tiers.service.js. Never settable by the user themselves.
  is_owner       BOOLEAN NOT NULL DEFAULT FALSE,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The catalog of tools on the platform. `is_active = FALSE` means "coming
-- soon" — the frontend lists it greyed out instead of hiding it entirely, so
-- the roadmap is visible to signed-in users from day one.
CREATE TABLE tools (
  slug         TEXT PRIMARY KEY,      -- e.g. 'invoice-generator'
  name         TEXT NOT NULL,         -- e.g. 'Invoice Generator'
  description  TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What each tier of each tool is allowed to do, as data rather than code —
-- this is what lets one generic tiers.service.js enforce limits for every
-- tool without a tool-specific if/else ladder. `limits` is a free-form JSON
-- bag; each tool defines and reads its own keys (e.g.
-- {"max_invoices_per_month": 5, "recurring_invoices": false}).
CREATE TABLE tool_tiers (
  id                 SERIAL PRIMARY KEY,
  tool_slug          TEXT NOT NULL REFERENCES tools(slug),
  tier               TEXT NOT NULL,        -- 'free' | 'pro' (a tool may add more later)
  monthly_price_cents INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'usd',
  limits             JSONB NOT NULL DEFAULT '{}',
  stripe_price_id    TEXT,                 -- NULL for the free tier
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tool_slug, tier)
);

-- One row per (user, tool) — which tier they're on right now. Absence of a
-- row means "free tier, never upgraded" (tiers.service.js treats a missing
-- row as an implicit free subscription so every tool doesn't have to insert
-- one at signup time).
CREATE TABLE subscriptions (
  id                     SERIAL PRIMARY KEY,
  user_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_slug              TEXT NOT NULL REFERENCES tools(slug),
  tier                   TEXT NOT NULL DEFAULT 'free',
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','past_due','canceled')),
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  current_period_end     TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, tool_slug)
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id);

-- Rolling monthly counters used to enforce free-tier caps like "5 invoices
-- per month". `period_start` is always the 1st of the month, so "this
-- month's usage" is one indexed lookup, and a new month just means a new row
-- instead of a reset job that has to run on schedule.
CREATE TABLE usage_counters (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_slug    TEXT NOT NULL REFERENCES tools(slug),
  metric       TEXT NOT NULL,          -- e.g. 'invoices_created'
  period_start DATE NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, tool_slug, metric, period_start)
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed the tool catalog: Invoice Generator is the first fully-built tool;
-- the rest are visible as "coming soon" placeholders straight away.
INSERT INTO tools (slug, name, description, is_active, sort_order) VALUES
  ('invoice-generator',    'Invoice Generator',       'Create and send branded invoices, track payments, and automate recurring billing.', TRUE,  1),
  ('appointment-booking',  'Appointment Booking',     'Booking pages, reminders, and customer records for salons, clinics, and consultants.', FALSE, 2),
  ('inventory-management', 'Inventory Management',    'Track products, stock levels, and low-stock alerts.', FALSE, 3),
  ('staff-attendance',     'Staff Attendance',        'QR check-in, attendance reports, and payroll export.', FALSE, 4),
  ('property-management',  'Property Management',     'Track tenants, rent, and maintenance requests.', FALSE, 5),
  ('expense-tracker',      'Expense Tracker',         'Record expenses, generate reports, and track budgets.', FALSE, 6),
  ('queue-management',     'Queue Management',        'Digital ticketing and notifications for waiting customers.', FALSE, 7),
  ('leave-management',     'Employee Leave Management','Leave requests and manager approvals.', FALSE, 8),
  ('membership-management','Membership Management',   'Member records, renewals, and payment reminders for gyms, clubs, and associations.', FALSE, 9);

-- Invoice Generator's own tier limits.
INSERT INTO tool_tiers (tool_slug, tier, monthly_price_cents, currency, limits, stripe_price_id) VALUES
  ('invoice-generator', 'free', 0,    'usd', '{"max_invoices_per_month": 5, "recurring_invoices": false, "remove_branding": false}', NULL),
  ('invoice-generator', 'pro',  900,  'usd', '{"max_invoices_per_month": null, "recurring_invoices": true, "remove_branding": true}', NULL);
