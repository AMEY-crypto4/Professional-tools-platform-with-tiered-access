-- Staff Attendance — tool #7.
UPDATE tools SET is_active = TRUE WHERE slug = 'staff-attendance';

INSERT INTO tool_tiers (tool_slug, tier, monthly_price_cents, currency, limits, stripe_price_id) VALUES
  ('staff-attendance', 'free', 0,   'usd', '{"max_employees": 5, "payroll_export": false}', NULL),
  ('staff-attendance', 'pro',  700, 'usd', '{"max_employees": null, "payroll_export": true}', NULL);

CREATE TABLE sa_employees (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  employee_code  TEXT NOT NULL,
  email          TEXT,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, employee_code)
);
CREATE INDEX idx_sa_employees_user ON sa_employees(user_id);

CREATE TABLE sa_attendance_records (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id     INTEGER NOT NULL REFERENCES sa_employees(id),
  work_date       DATE NOT NULL,
  check_in_time   TIMESTAMPTZ,
  check_out_time  TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present','absent','late')),
  UNIQUE (employee_id, work_date)
);
CREATE INDEX idx_sa_records_user_date ON sa_attendance_records(user_id, work_date DESC);

-- One random, unguessable token per business account, used ONLY by the
-- public kiosk check-in endpoint (no login) to resolve which account's
-- employee roster to check against — see staffAttendance.routes.js. This is
-- the "print a QR code, staff scan it, no per-employee login needed"
-- pattern the reel describes; it's a capability token (like an invite
-- code), not a user identity.
CREATE TABLE sa_kiosk_tokens (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
