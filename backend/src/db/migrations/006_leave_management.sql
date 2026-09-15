-- Employee Leave Management — tool #5.
--
-- Note on scope: this platform has no concept of a per-employee login (each
-- account here is one business owner). "Manager approval" is therefore
-- modeled as the owner recording a request on an employee's behalf and then
-- deciding it themselves — a real, useful leave register and approval log,
-- just without a self-service employee portal. Building actual sub-accounts
-- per employee would be a separate, much larger auth feature.
UPDATE tools SET is_active = TRUE WHERE slug = 'leave-management';

INSERT INTO tool_tiers (tool_slug, tier, monthly_price_cents, currency, limits, stripe_price_id) VALUES
  ('leave-management', 'free', 0,   'usd', '{"max_employees": 5}', NULL),
  ('leave-management', 'pro',  600, 'usd', '{"max_employees": null}', NULL);

CREATE TABLE lm_employees (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lm_employees_user ON lm_employees(user_id);

CREATE TABLE lm_leave_requests (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id   INTEGER NOT NULL REFERENCES lm_employees(id),
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX idx_lm_requests_user ON lm_leave_requests(user_id, start_date DESC);
