-- Invoice Generator — tool #1.
-- All tables are scoped by user_id directly: every account here is an
-- independent business/freelancer, not a member of a shared org, so "who
-- can see this row" is always just "does row.user_id = req.user.sub".

CREATE TABLE ig_clients (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  address     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ig_clients_user ON ig_clients(user_id);

CREATE TABLE ig_invoices (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id             INTEGER NOT NULL REFERENCES ig_clients(id),
  invoice_number        TEXT NOT NULL,       -- unique per user, not globally (each business has its own numbering)
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','overdue','void')),
  issue_date            DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date              DATE,
  currency              TEXT NOT NULL DEFAULT 'usd',
  subtotal_cents        BIGINT NOT NULL DEFAULT 0,
  tax_percent           NUMERIC(5,2) NOT NULL DEFAULT 0,
  total_cents           BIGINT NOT NULL DEFAULT 0,
  notes                 TEXT,
  -- Recurring invoices are a Pro-only feature (see tool_tiers.limits) —
  -- enforced at write time in invoices.service.js, not just hidden in the UI.
  is_recurring          BOOLEAN NOT NULL DEFAULT FALSE,
  recurrence_interval   TEXT CHECK (recurrence_interval IN ('weekly','monthly','yearly')),
  next_recurrence_date  DATE,
  paid_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, invoice_number)
);
CREATE INDEX idx_ig_invoices_user ON ig_invoices(user_id, issue_date DESC);
CREATE INDEX idx_ig_invoices_recurrence ON ig_invoices(next_recurrence_date) WHERE is_recurring = TRUE;

CREATE TABLE ig_invoice_items (
  id               SERIAL PRIMARY KEY,
  invoice_id       INTEGER NOT NULL REFERENCES ig_invoices(id) ON DELETE CASCADE,
  description      TEXT NOT NULL,
  quantity         NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price_cents BIGINT NOT NULL DEFAULT 0,
  amount_cents     BIGINT NOT NULL DEFAULT 0,  -- quantity * unit_price_cents, computed server-side at save time
  sort_order       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ig_invoice_items_invoice ON ig_invoice_items(invoice_id);

CREATE TRIGGER trg_ig_invoices_updated_at BEFORE UPDATE ON ig_invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
