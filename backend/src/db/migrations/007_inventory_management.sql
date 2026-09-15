-- Inventory Management — tool #6.
UPDATE tools SET is_active = TRUE WHERE slug = 'inventory-management';

INSERT INTO tool_tiers (tool_slug, tier, monthly_price_cents, currency, limits, stripe_price_id) VALUES
  ('inventory-management', 'free', 0,   'usd', '{"max_products": 20}', NULL),
  ('inventory-management', 'pro',  700, 'usd', '{"max_products": null}', NULL);

CREATE TABLE inv_products (
  id                   SERIAL PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  sku                  TEXT,
  price_cents          BIGINT NOT NULL DEFAULT 0,
  quantity_on_hand     INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold  INTEGER NOT NULL DEFAULT 5,
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_inv_products_user ON inv_products(user_id);

-- Append-only ledger of every stock change — the product's quantity_on_hand
-- is a cached total kept in sync inside a transaction (see
-- inventoryManagement.service.js#adjustStock), not the source of truth on
-- its own, so "why did stock change" always has an answer.
CREATE TABLE inv_stock_movements (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES inv_products(id) ON DELETE CASCADE,
  change_qty    INTEGER NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN ('restock','sale','adjustment')),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_inv_movements_product ON inv_stock_movements(product_id, created_at DESC);
