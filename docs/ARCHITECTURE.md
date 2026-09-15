# Architecture

## The core idea

Every tool on this platform (Invoice Generator today; Appointment Booking,
Inventory Management, etc. later) is a separate set of tables and routes,
but they all share ONE accounts/tiers/billing engine instead of each
reinventing "is this user allowed to do X". That engine is four tables plus
one service file:

- `tools` — the catalog. One row per tool, `is_active` toggles "coming soon"
  vs. live.
- `tool_tiers` — what each tier of each tool allows, as data
  (`limits` JSONB) plus its `provider_price_id` (whatever the active payment
  provider calls its price/plan id). Adding a "Business" tier to Invoice
  Generator later is one INSERT, not a code change.
- `subscriptions` — which tier each user is on for each tool, kept in sync
  by webhooks from whichever provider (`provider` column) that subscription
  is on. No row = implicitly free.
- `usage_counters` — rolling monthly counters (e.g. "invoices created this
  month") used to enforce numeric caps like "5 invoices/month on free".
- `backend/src/services/tiers.service.js` — reads all of the above.
  `hasFeature(user, toolSlug, key)` for boolean gates (e.g. "recurring
  invoices"), `assertWithinLimitAndIncrement(...)` for numeric caps (throws
  a 402 with a clear message when a cap is hit, otherwise increments the
  counter). Every tool's write routes call into this instead of hardcoding
  numbers.

The **owner bypass** lives in one place too: any account whose email is
listed in `OWNER_EMAILS` gets `is_owner = TRUE` (checked at signup and every
login, so adding an email upgrades an existing account on next sign-in).
`getEffectiveTier()` reports owner accounts as each tool's highest
configured tier, which makes every `hasFeature`/limit check pass without
special-casing "unless they're the owner" everywhere.

## Why tier enforcement happens server-side, not just in the UI

The free-tier cap and the recurring-invoices Pro gate are both checked
**inside the service function that performs the write**
(`igInvoices.service.js`), not just hidden in the frontend. Calling the API
directly (curl, Postman, a modified frontend) cannot bypass either — that's
the whole point of a paid tier existing.

## Payment providers: two, behind one dispatcher

`tiers.service.js` and every tool's routes only ever read the
`subscriptions`/`tool_tiers` tables — they never call a payment provider's
SDK directly. Two providers are actually implemented,
`src/services/payments/stripeProvider.js` and `razorpayProvider.js`, each
exporting the same shape (`isConfigured`, `createCheckoutSession`,
`verifyCheckout`, `cancelSubscription`, `constructWebhookEvent`,
`handleWebhookEvent`). `billing.service.js` is a thin dispatcher that picks
one (`PAYMENT_PROVIDER` env var, or auto-detect favoring Razorpay — see
`docs/ROADMAP.md` for why Razorpay is the practical default for India) and
delegates to it. Nothing outside those three files ever imports `stripe` or
`razorpay`.

This exists because Stripe requires an invite for new India-based merchants
(see ROADMAP), so a platform actually usable from India on day one needs a
provider that isn't invite-gated. The two providers' checkout flows are
genuinely different shapes — Stripe redirects to a hosted page and confirms
purchases purely via webhook; Razorpay opens an in-page widget and needs an
extra client-side signature-verification round trip (`POST
/api/billing/verify`) for instant feedback, with the webhook as the eventual
source of truth for renewals/cancellations. `createCheckoutSession`'s return
value is tagged with `provider` specifically so the frontend can branch on
it (see `startCheckout()` in `frontend/index.html`) without needing to know
which provider is active ahead of time.

## Why the webhook routes are mounted before `express.json()`

Both providers sign the *exact raw bytes* of their webhook request body —
Stripe with the `stripe-signature` header, Razorpay with
`X-Razorpay-Signature`. `express.json()` parses (and thereby discards) the
raw body the moment it runs, so if it ran first, signature verification
would always fail for either one. See the comment in `backend/src/app.js` —
any route that needs the untouched raw body (or that must skip a
blanket-applied auth check, like the two public kiosk/join routers) has to
be registered before the middleware it needs to run ahead of, not after —
Express matches `app.use()` in registration order, not by path specificity.

## Why Razorpay's checkout signature is verified against OUR stored id

`razorpayProvider.verifyCheckout()` deliberately ignores the
`razorpay_subscription_id` the client sends when computing the expected
signature — it looks up the subscription id **we stored** for that
user+tool at `createCheckoutSession` time and uses that instead, only using
the client-sent id for an equality sanity-check first. A client can't get a
valid signature accepted for a subscription that isn't the one we already
expected, even if it supplies a real subscription id and a correctly
Razorpay-signed payment id for some *other* subscription — see
`smoke-test-razorpay-signature.sh`'s "mismatched subscription id" case,
which exercises exactly this.

## Multi-tenancy model

Every account here is an independent tenant — a business or freelancer with
no relationship to any other account, no offices, no orgs. Every tool's
tables are scoped directly by `user_id`, and every query filters on it.
That's simpler than a multi-office/multi-org model, but it does mean every
new table in every new tool needs its own `user_id` foreign key and its own
`WHERE user_id = $1` by hand — there's no shared scoping helper doing that
check for you.
