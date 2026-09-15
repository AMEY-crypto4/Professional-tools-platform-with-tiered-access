-- Membership Management — tool #4.
UPDATE tools SET is_active = TRUE WHERE slug = 'membership-management';

INSERT INTO tool_tiers (tool_slug, tier, monthly_price_cents, currency, limits, stripe_price_id) VALUES
  ('membership-management', 'free', 0,   'usd', '{"max_members": 15}', NULL),
  ('membership-management', 'pro',  600, 'usd', '{"max_members": null}', NULL);

CREATE TABLE mm_members (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  email            TEXT,
  phone            TEXT,
  membership_type  TEXT NOT NULL DEFAULT 'standard',
  join_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_mm_members_user ON mm_members(user_id);

-- Each payment covers one period; a member's current standing is derived
-- from the latest period_end rather than stored redundantly on mm_members,
-- so it's never possible for the two to drift out of sync.
CREATE TABLE mm_payments (
  id            SERIAL PRIMARY KEY,
  member_id     INTEGER NOT NULL REFERENCES mm_members(id) ON DELETE CASCADE,
  amount_cents  BIGINT NOT NULL,
  paid_on       DATE NOT NULL DEFAULT CURRENT_DATE,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_mm_payments_member ON mm_payments(member_id);
