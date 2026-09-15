# Deployment (free to start)

A proven free-tier stack: **Supabase** for Postgres, **Render** for the API,
**Netlify** for the static frontend.

## 1. Database — Supabase

1. Create a project at supabase.com (free tier).
2. Settings → Database → copy the connection string (use the "connection
   pooling" URI, port 6543, for serverless-friendly connections).
3. That's your `DATABASE_URL`.

## 2. API — Render

1. New Web Service, point it at this repo's `backend/` directory.
2. Build command: `npm install`. Start command: `npm start`.
3. Environment variables: `DATABASE_URL`, `JWT_SECRET` (generate with
   `openssl rand -hex 32`), `OWNER_EMAILS`, `CORS_ORIGINS` (your Netlify
   URL), and the `STRIPE_*` vars once you've set up billing (see the main
   README).
4. After the first deploy, run the migration once — either via Render's
   Shell tab (`npm run migrate`) or by adding a one-off Render Job.
5. **Recurring invoices**: add a Render Cron Job running
   `npm run cron:recurring-invoices` once a day, with the same environment
   variables as the web service.

## 3. Frontend — Netlify

1. New site from this repo, base directory `frontend/`, no build command
   (it's static).
2. Edit `frontend/config.js` to point `AACREATIONS_API_BASE` at your
   Render API URL before deploying (or template it via a Netlify
   environment variable + a tiny build step later, if you want one config
   per environment).

## Scaling checklist (upgrade when you actually hit these)

- **Postgres connections**: Supabase's free tier caps concurrent
  connections — if you outgrow it, switch `DATABASE_URL` to the pooled
  connection string (already recommended above) before anything else.
- **Render free tier spins down when idle** — the first request after a
  quiet period is slow. Fine for early users; upgrade to a paid instance
  once that latency matters to real customers.
- **Stripe test mode → live mode**: swap `STRIPE_SECRET_KEY` and
  `STRIPE_WEBHOOK_SECRET` for their live-mode equivalents once you're ready
  to take real payments — everything else is unchanged.
