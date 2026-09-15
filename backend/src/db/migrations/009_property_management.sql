-- Property Management — tool #8. Tier cap is on properties (matching how
-- the reel describes pricing this — "charge based on the number of
-- properties they manage") rather than units/tenants, which are unlimited
-- per property on both tiers.
UPDATE tools SET is_active = TRUE WHERE slug = 'property-management';

INSERT INTO tool_tiers (tool_slug, tier, monthly_price_cents, currency, limits, stripe_price_id) VALUES
  ('property-management', 'free', 0,   'usd', '{"max_properties": 2}', NULL),
  ('property-management', 'pro',  900, 'usd', '{"max_properties": null}', NULL);

CREATE TABLE pm_properties (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  address     TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pm_properties_user ON pm_properties(user_id);

CREATE TABLE pm_units (
  id                 SERIAL PRIMARY KEY,
  property_id        INTEGER NOT NULL REFERENCES pm_properties(id) ON DELETE CASCADE,
  unit_label         TEXT NOT NULL,
  monthly_rent_cents BIGINT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pm_units_property ON pm_units(property_id);

CREATE TABLE pm_tenants (
  id           SERIAL PRIMARY KEY,
  unit_id      INTEGER NOT NULL REFERENCES pm_units(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  email        TEXT,
  phone        TEXT,
  lease_start  DATE,
  lease_end    DATE,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pm_tenants_unit ON pm_tenants(unit_id);

CREATE TABLE pm_maintenance_requests (
  id            SERIAL PRIMARY KEY,
  unit_id       INTEGER NOT NULL REFERENCES pm_units(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);
CREATE INDEX idx_pm_maintenance_unit ON pm_maintenance_requests(unit_id);
