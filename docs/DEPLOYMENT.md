# Deployment (free to start)

A proven free-tier stack: **Supabase** for Postgres, **Render** for the API
(using `backend/render.yaml` as a Blueprint — Render reads it and creates
the service with most settings pre-filled), **Netlify** for the static
frontend. GitHub already has the code — see the main README.

## 1. Database — Supabase

1. Create a project at supabase.com (free tier).
2. Settings → Database → copy the connection string (use the **connection
   pooling** URI, port 6543 — not the direct connection, which serverless
   platforms like Render exhaust the connection limit on).
3. That's your `DATABASE_URL`. Nothing else to do here yet — migrations run
   automatically on first deploy (see below).

## 2. API — Render

1. New → Blueprint → connect the GitHub repo. Render finds
   `backend/render.yaml` automatically and shows every env var it needs.
2. Fill in the ones marked `sync: false` in that file:
   - `DATABASE_URL` — from step 1.
   - `OWNER_EMAILS` — the email(s) that get free Pro access to every tool.
   - `CORS_ORIGINS` and `FRONTEND_URL` — you don't have the Netlify URL yet;
     put in a placeholder (e.g. `https://placeholder.netlify.app`) and come
     back to fix these after step 3.
   - `RAZORPAY_*` / `STRIPE_*` — leave blank for now if you haven't set up
     billing yet; every tool still works free with these unset.
3. Deploy. `startCommand: npm run migrate && npm start` means the schema is
   created automatically on this first boot — no separate migration step.
4. Once it's live, note the URL Render gives you (`https://aa-creations-api-xxxx.onrender.com`)
   — you'll need it for the frontend.
5. **Recurring invoices** (optional, only matters once Invoice Generator has
   a real Pro/recurring customer): add a Render Cron Job running
   `npm run cron:recurring-invoices` once a day, same env vars as the web
   service. Check Render's current Cron Job pricing before adding one — it
   may not be covered by the free plan.

## 3. Frontend — Netlify

1. New site from Git → same GitHub repo, base directory `frontend/`, no
   build command (it's static — `netlify.toml` is already there).
2. Before deploying (or right after, then redeploy), edit
   `frontend/config.js` locally to point `AACREATIONS_API_BASE` at the
   Render URL from step 2, then commit and push — Netlify redeploys
   automatically on every push to `main`.
3. Once Netlify gives you its URL, go back to Render and update
   `CORS_ORIGINS` and `FRONTEND_URL` to that real URL (comma-separate if you
   later add a custom domain too), then Render redeploys with the fix.

## 4. Verify it's actually live

1. `curl https://your-render-url.onrender.com/api/health` → `{"ok":true,...}`.
2. Open the Netlify URL, sign up, confirm the dashboard loads all 9 tools.
3. Sign in with the `OWNER_EMAILS` account and confirm it shows Pro/unlimited
   on every tool.

## Scaling checklist (upgrade when you actually hit these)

- **Postgres connections**: Supabase's free tier caps concurrent
  connections — if you outgrow it, you're already on the pooled connection
  string (recommended above), so the next step is Supabase's paid tier.
- **Render free tier spins down when idle** — the first request after a
  quiet period is slow (10-60s). Fine for early users; upgrade to a paid
  instance once that latency matters to real customers.
- **Payment provider test mode → live mode**: swap test-mode keys for
  live-mode ones (Razorpay: `rzp_test_...` → `rzp_live_...`; Stripe:
  `sk_test_...` → `sk_live_...`) once you're ready to take real payments —
  everything else is unchanged. Re-run `npm run setup:razorpay-plans` in
  live mode too, since live and test mode have separate Plans.
- **Custom domain**: both Render and Netlify support adding your own domain
  for free — DNS records only, no extra hosting cost.
