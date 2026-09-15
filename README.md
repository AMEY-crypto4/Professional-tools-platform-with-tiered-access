# A&A Creations — Tools Suite

A multi-tool SaaS platform: one shared account/tier/billing system that all
nine tools plug into. Node/Express/PostgreSQL API + a thin JS frontend, no
build step — a simple, proven stack for a public multi-tenant product.

**All 9 tools are built and working:** Invoice Generator, Appointment
Booking, Expense Tracker, Membership Management, Employee Leave Management,
Inventory Management, Staff Attendance, Property Management, and Queue
Management. See `docs/ROADMAP.md` for what each one does and its honest
limitations (no real SMS/push notifications, no per-employee logins, etc.).

**Start here:** `docs/ARCHITECTURE.md` (how the tiers/billing engine works
and why), `docs/ROADMAP.md` (what's built, its limitations, and the recipe
for adding a 10th tool), `docs/DEPLOYMENT.md` (free-tier hosting steps).

## Quick start (local)

Requires Node 18+ and PostgreSQL running locally.

```bash
cd backend
cp .env.example .env
# Edit .env: set a real DATABASE_URL, a random JWT_SECRET
#   (generate one with: openssl rand -hex 32), and OWNER_EMAILS to an email
#   dedicated to this side business — that account gets every tool's top
#   tier for free the moment it signs up or logs in.

npm install
npm run migrate   # creates all tables + seeds the tool catalog and tiers

npm start         # http://localhost:4000
```

Verify the backend actually works before touching the frontend:
```bash
SMOKE_OWNER_EMAIL=you@example.com bash smoke-test.sh   # 19 checks: auth, owner bypass, tiers
                                                        # dashboard, Invoice Generator CRUD,
                                                        # free-tier limit + 402, recurring-invoice
                                                        # gating, PDF export, billing status
                                                        # (SMOKE_OWNER_EMAIL must be listed in the
                                                        # server's OWNER_EMAILS)
bash smoke-test-tools-2-9.sh              # 31 checks: the other 8 tools — CRUD, tier limits,
                                           # double-booking guard, overselling guard, public
                                           # kiosk check-in, public queue join + call-next
bash smoke-test-razorpay-signature.sh     # 9 checks: checkout signature verification,
                                           # webhook signature verification + event handling
                                           # (needs RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET
                                           # set — any value works, see the Billing section)
```
All three require `jq`, `openssl`, and a running server on `:4000` (set the
`BASE` env var to override, e.g. `BASE=http://127.0.0.1:4100/api`).

## Frontend

`frontend/index.html` is a single static file — no build step. Open it
directly, or serve it:
```bash
cd frontend
python3 -m http.server 8080   # or: npx serve
```
It talks to `http://localhost:4000/api` by default. To point it at a
deployed API, edit `frontend/config.js`.

## Billing (Razorpay and/or Stripe)

Every tool works fully on its free tier with **zero payment setup** —
`/api/billing/*` just returns a clear "not configured" error until you add
keys, on every tool, not just Invoice Generator. Two providers are wired up;
`billing.service.js` auto-picks whichever is configured (Razorpay wins if
both are, since it's what most India-based accounts can actually get —
override with `PAYMENT_PROVIDER=stripe` if you want Stripe instead once you
have it). Neither provider's SDK is called from anywhere except its own file
under `src/services/payments/` — the tier engine, every tool's routes, and
the frontend only ever go through the dispatcher.

### Razorpay (works for India today, no invite needed)

1. **Create your own Razorpay account** — I can't do this step; account
   creation needs your own PAN and bank account. Go to
   [dashboard.razorpay.com/signup](https://dashboard.razorpay.com/signup).
   Razorpay supports unregistered/individual proprietorships in India, so
   this works even before you've formally registered a business.
2. Get your **test-mode** keys from Dashboard → Settings → API Keys (test
   mode is free — only live-mode charges cost anything). Set
   `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in `backend/.env`.
3. Run `npm run setup:razorpay-plans` — this creates a Razorpay Plan for
   every tool's Pro tier via the API and saves the plan id back into
   `tool_tiers.provider_price_id`. Re-run any time you add a new tool's
   pricing; it only touches tools that don't have a plan yet.
4. For webhooks: Dashboard → Account & Settings → Webhooks → add
   `https://your-api.example.com/api/billing/webhook/razorpay`, subscribe to
   the `subscription.*` events, and put the secret **you choose there** into
   `RAZORPAY_WEBHOOK_SECRET` (this value doesn't come from Razorpay — you
   invent it and enter it in both places).
5. Bring up the frontend and try an upgrade — Razorpay's Checkout opens as
   an in-page widget, not a redirect, so there's nothing else to configure
   on the frontend side.

### Stripe (once you have access)

New India-registered businesses currently need an invite
(`stripe.com/in/contact/sales`) — see `docs/ROADMAP.md` for what that
requires. If you get in, or already have a Stripe account for an entity
outside India:

1. Create a Product + a recurring Price for each paid tier and copy its
   Price ID into that tier's `provider_price_id` column in `tool_tiers`
   (there's no auto-setup script for Stripe the way there is for Razorpay —
   Stripe Prices are simple enough to add by hand in the Dashboard).
2. Set `STRIPE_SECRET_KEY` in `backend/.env`, and `PAYMENT_PROVIDER=stripe`
   if Razorpay is also configured and you want Stripe to win.
3. For webhooks locally: `stripe listen --forward-to localhost:4000/api/billing/webhook/stripe`
   and put the printed secret in `STRIPE_WEBHOOK_SECRET`. In production, add
   a webhook endpoint in the Stripe Dashboard pointing at
   `https://your-api.example.com/api/billing/webhook/stripe`.

### Testing without a real account

`backend/smoke-test-razorpay-signature.sh` proves the security-critical part
— HMAC signature verification for both checkout confirmation and webhooks —
entirely with fake credentials, since that logic never calls Razorpay's
actual API (only creating and cancelling a subscription do). It won't catch
a real account's specific quirks, but it does prove the cryptography and the
tier-update logic are correct.

## Recurring invoices

Invoice Generator's recurring-invoice feature needs a daily job:
```bash
cd backend
npm run cron:recurring-invoices
```
Run this once a day from an external scheduler (Render Cron Job, a GitHub
Actions scheduled workflow, Windows Task Scheduler) — see the comment at the
top of `backend/src/jobs/generateRecurringInvoices.js` for why it's not just
a `setInterval` inside the API process.

## Public links (no login required)

Two tools generate shareable links that work without an account:
- **Staff Attendance**: a kiosk link (`frontend/kiosk.html?token=...`) for
  employees to check in/out from a shared tablet or phone.
- **Queue Management**: a join link (`frontend/join-queue.html?token=...`)
  for customers to take a ticket and poll their status.

Both tokens are per-business capability tokens (like an invite code), not
user identities — see the comments in `sa_kiosk_tokens` / `qm_queues.
join_token` in their migrations.

## Project layout

```
backend/
  src/db/migrations/     -- SQL schema, applied in order by npm run migrate
                             001 = platform core (users/tools/tiers/billing/usage)
                             002-010 = one tool's own tables each, in build order
                             011-012 = generic (multi-provider) billing columns
  src/services/tiers.service.js       -- the generic engine every tool's limits run through
  src/services/billing.service.js     -- picks the active provider, nothing else touches Stripe/Razorpay
  src/services/payments/stripeProvider.js    -- Stripe-specific implementation
  src/services/payments/razorpayProvider.js  -- Razorpay-specific implementation
  src/services/ig*.service.js      -- Invoice Generator's business logic
  src/services/ab*.service.js      -- Appointment Booking's business logic
  src/services/<tool>.service.js   -- one file per remaining tool
  src/routes/            -- HTTP layer only — thin, delegates to services/
  src/jobs/              -- scripts meant to run on an external schedule or once
  smoke-test.sh                     -- 19 checks: Invoice Generator
  smoke-test-tools-2-9.sh           -- 31 checks: the other 8 tools
  smoke-test-razorpay-signature.sh  -- 9 checks: billing signature verification
frontend/
  index.html             -- the whole dashboard + all 9 tools' UI, single file
  kiosk.html             -- public staff check-in page (Staff Attendance)
  join-queue.html        -- public take-a-ticket page (Queue Management)
  config.js              -- the one line you edit to point at a deployed API
docs/
  ARCHITECTURE.md         -- how the tiers/billing engine works
  ROADMAP.md              -- what's built, its limitations, recipe for tool #10
  DEPLOYMENT.md            -- free-tier setup steps
```
