-- Queue Management — tool #9, the last one.
UPDATE tools SET is_active = TRUE WHERE slug = 'queue-management';

INSERT INTO tool_tiers (tool_slug, tier, monthly_price_cents, currency, limits, stripe_price_id) VALUES
  ('queue-management', 'free', 0,   'usd', '{"max_active_queues": 1}', NULL),
  ('queue-management', 'pro',  600, 'usd', '{"max_active_queues": null}', NULL);

-- join_token is the public "scan this QR to take a ticket" capability token
-- — same pattern as sa_kiosk_tokens, scoped to one queue instead of one
-- whole account since a business may run several queues (e.g. "General",
-- "Billing") each with their own join link and display board.
CREATE TABLE qm_queues (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  join_token  TEXT NOT NULL UNIQUE,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_qm_queues_user ON qm_queues(user_id);

-- ticket_number resets daily per queue (computed at insert time from that
-- day's count), matching how a physical take-a-number dispenser behaves.
CREATE TABLE qm_tickets (
  id             SERIAL PRIMARY KEY,
  queue_id       INTEGER NOT NULL REFERENCES qm_queues(id) ON DELETE CASCADE,
  ticket_number  INTEGER NOT NULL,
  customer_name  TEXT,
  status         TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','called','served','cancelled')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  called_at      TIMESTAMPTZ,
  served_at      TIMESTAMPTZ
);
CREATE INDEX idx_qm_tickets_queue ON qm_tickets(queue_id, created_at DESC);
