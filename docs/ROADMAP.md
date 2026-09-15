# Roadmap

## Built and verified right now — all 9 tools

- Accounts: open signup/login, JWT auth, owner-email bypass (`OWNER_EMAILS`).
- Tools catalog + tier engine: `tools`, `tool_tiers`, `subscriptions`,
  `usage_counters` tables; `tiers.service.js`'s `hasFeature` /
  `assertWithinLimitAndIncrement` / `assertResourceLimit` (for "max N active
  records" caps like max services/members/properties, as opposed to the
  monthly-rate caps the first one handles) / `getUsageSummary`.
- Billing: Stripe Checkout + customer portal + webhook handling, all
  optional (every tool works free with zero Stripe setup).
- **Invoice Generator**: clients, invoices with line items/tax/totals, draft
  editing, status lifecycle, branded PDF export (watermark on free tier,
  clean on Pro), free-tier cap of 5 invoices/month, Pro-only recurring
  invoices with a daily generation job (`npm run cron:recurring-invoices`).
- **Appointment Booking**: services, clients, appointments with a
  double-booking guard (no two scheduled appointments may overlap for the
  same account); free tier capped at 1 service and 20 appointments/month.
- **Expense Tracker**: expenses by category, a monthly summary report,
  Pro-only per-category budgets with an over-budget flag; free tier capped
  at 30 expenses/month.
- **Membership Management**: members, payment history, membership status
  (active/expiring_soon/expired/no_payment) derived from the latest
  payment's period end; free tier capped at 15 members.
- **Employee Leave Management**: an employee roster (no per-employee login —
  see the note in migration `006`) and a leave request/approval log; free
  tier capped at 5 employees.
- **Inventory Management**: products with an append-only stock-movement
  ledger (every quantity change is written alongside the movement that
  explains it, inside one transaction), a low-stock view, an "insufficient
  stock" guard against overselling; free tier capped at 20 products.
- **Staff Attendance**: employees, a public no-login kiosk check-in/out
  endpoint (`frontend/kiosk.html`, token-gated), a Pro-only payroll CSV
  export; free tier capped at 5 employees.
- **Property Management**: properties → units → tenants → maintenance
  requests, tier-capped on properties (matching how the reel describes
  pricing this) rather than units, which are unlimited on both tiers.
- **Queue Management**: queues, a public no-login "take a ticket" join link
  and status-polling page (`frontend/join-queue.html`), call-next/mark-served
  for the business side; free tier capped at 1 active queue.
- Frontend: signup/login, dashboard grid of all 9 tools with live
  tier/usage badges, upgrade modal, and a full working UI for every tool.
- Billing: a dispatcher (`billing.service.js`) picking between two fully
  implemented providers — Razorpay (works for India today, no invite) and
  Stripe (once you have access) — never both called from the same place.
  Real signature verification for both checkout confirmation and webhooks,
  tested against fake-but-correctly-signed requests since neither needs a
  live account to verify the cryptography and DB updates are right.
- Three smoke-test suites (`smoke-test.sh`, `smoke-test-tools-2-9.sh`,
  `smoke-test-razorpay-signature.sh`) — 59 automated checks total against a
  real Postgres database, re-run clean after every change.

## Honest limitations (by design, not oversight)

- **No real-time push notifications.** Queue Management's ticket status and
  any "reminder" concept elsewhere are poll-based (refresh to check), not
  SMS/push. Wiring up actual notifications needs an SMS/email provider
  (Twilio, etc.) — not set up here, same reasoning as Gmail below.
- **No per-employee logins.** Staff Attendance and Leave Management both
  model "employees" as records the account owner manages, not separate
  platform accounts — there's no sub-account/multi-user-per-business system
  yet. Building one is a real, separate auth feature, not a quick add.
- **Emailing invoices to clients.** A Gmail OAuth integration (connect →
  encrypted refresh token → send-as-user) would bolt onto Invoice
  Generator's "sent" status. Deferred because it needs its own
  Google Cloud OAuth client, which only you can create.
- **Real payment provider credentials.** Every tool's `tool_tiers` row has a
  `provider_price_id` column ready; they're `NULL` until you either run
  `npm run setup:razorpay-plans` (after adding Razorpay keys) or create
  Products/Prices by hand in your Stripe dashboard — see the main README's
  Billing section. Upgrades return a clear "not configured" error until
  then, on every tool.
- **Stripe access for India.** Confirmed directly from Stripe's own support
  pages (stripe.com/in/contact/sales is the actual request path): India
  moved to invite-only in May 2024 for RBI payment-aggregator compliance,
  Stripe doesn't onboard individuals there (a registered proprietorship/LLP/
  company is required), and there's no published approval timeline. Razorpay
  is the practical default for this platform's India-based users as a
  result — see the Billing section in the main README.
- **Recurring invoices need a scheduler.** The generation script works
  (verified by manually forcing a due date and running it) but nothing
  triggers it automatically yet — see the main README's note on this.

## The recipe for adding a tenth tool

The same recipe that built tools #2–#9 still applies to whatever comes
next:

1. `INSERT INTO tools (...)` for the new tool's catalog row.
2. `INSERT INTO tool_tiers (...)` for its free/pro limits, in its own
   migration file — migrations are append-only once applied, never edit an
   old one.
3. That migration's own `user_id`-scoped tables (or scoped through a parent
   resource's `user_id`, the way Property Management's units/tenants/
   maintenance-requests are — see `009_property_management.sql` and the
   ownership-chain joins in `propertyManagement.service.js`).
4. `src/services/<tool>.service.js` — calls `tiers.service.js`'s
   `hasFeature` / `assertWithinLimitAndIncrement` (monthly caps) /
   `assertResourceLimit` (standing-count caps) at every write.
5. `src/routes/<tool>.routes.js` — thin HTTP layer, `requireAuth` on the
   router. If the tool needs a public no-login endpoint (kiosk-style, like
   Staff Attendance and Queue Management), export it as a **separate**
   router and mount it at a more specific path **before** the protected
   router in `app.js` — see the comment there for why the order matters.
6. Mount it in `app.js`.
7. Frontend: a new `render<Tool>()` function, registered in the
   `TOOL_RENDERERS` map near `openTool()`. Reuse `capBannerHtml()` /
   `getToolMeta()` for standing-count caps, or a tool-specific `/usage`
   endpoint (see Invoice Generator's or Appointment Booking's) for
   monthly-rate caps.
8. A new `smoke-test-<tool>.sh`, or add to `smoke-test-tools-2-9.sh` — CRUD,
   at least one tier-limit check, and one feature-gate or logic check
   (something like the double-booking guard or the overselling guard).

No step touches accounts, billing, or the tier engine — that was the whole
point of building it this way once.
