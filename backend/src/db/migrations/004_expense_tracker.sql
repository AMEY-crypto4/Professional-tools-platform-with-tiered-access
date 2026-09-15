-- Expense Tracker — tool #3.
UPDATE tools SET is_active = TRUE WHERE slug = 'expense-tracker';

INSERT INTO tool_tiers (tool_slug, tier, monthly_price_cents, currency, limits, stripe_price_id) VALUES
  ('expense-tracker', 'free', 0,   'usd', '{"max_expenses_per_month": 30, "budgets": false}', NULL),
  ('expense-tracker', 'pro',  500, 'usd', '{"max_expenses_per_month": null, "budgets": true}', NULL);

CREATE TABLE et_expenses (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  amount_cents  BIGINT NOT NULL,
  expense_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_et_expenses_user ON et_expenses(user_id, expense_date DESC);

-- Pro-only: a monthly ceiling per category, used to flag overspending in the
-- summary report. Free tier can create expenses in any category but never
-- sees budget rows (gated by hasFeature('budgets') in the service layer).
CREATE TABLE et_budgets (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category            TEXT NOT NULL,
  monthly_limit_cents BIGINT NOT NULL,
  UNIQUE (user_id, category)
);
