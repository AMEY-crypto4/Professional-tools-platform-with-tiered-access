-- Appointment Booking — tool #2.
UPDATE tools SET is_active = TRUE WHERE slug = 'appointment-booking';

INSERT INTO tool_tiers (tool_slug, tier, monthly_price_cents, currency, limits, stripe_price_id) VALUES
  ('appointment-booking', 'free', 0,   'usd', '{"max_appointments_per_month": 20, "max_services": 1}', NULL),
  ('appointment-booking', 'pro',  700, 'usd', '{"max_appointments_per_month": null, "max_services": null}', NULL);

CREATE TABLE ab_services (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  duration_minutes  INTEGER NOT NULL DEFAULT 30,
  price_cents       BIGINT NOT NULL DEFAULT 0,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ab_services_user ON ab_services(user_id);

CREATE TABLE ab_clients (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ab_clients_user ON ab_clients(user_id);

CREATE TABLE ab_appointments (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id     INTEGER NOT NULL REFERENCES ab_clients(id),
  service_id    INTEGER NOT NULL REFERENCES ab_services(id),
  start_time    TIMESTAMPTZ NOT NULL,
  end_time      TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled','no_show')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ab_appointments_user ON ab_appointments(user_id, start_time);

CREATE TRIGGER trg_ab_appointments_updated_at BEFORE UPDATE ON ab_appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
