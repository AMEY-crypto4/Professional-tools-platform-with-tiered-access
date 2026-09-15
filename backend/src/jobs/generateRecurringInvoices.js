// Run this once a day from an external scheduler — Render Cron Jobs, a
// GitHub Actions scheduled workflow, or Windows Task Scheduler all work, and
// all are free at this scale. Deliberately NOT run via setInterval() inside
// the API process: that would double-generate invoices the moment you ever
// run more than one server instance, and would silently stop running if the
// process restarts mid-day. An external, idempotent, once-a-day script has
// neither problem.
import 'dotenv/config';
import { pool } from '../db/pool.js';
import { generateDueRecurringInvoices } from '../services/igInvoices.service.js';

async function run() {
  const results = await generateDueRecurringInvoices();
  if (!results.length) {
    console.log('[recurring-invoices] nothing due today');
  } else {
    for (const r of results) {
      if (r.skipped) console.log(`[recurring-invoices] skipped template ${r.templateId} (${r.reason})`);
      else console.log(`[recurring-invoices] template ${r.templateId} -> created invoice ${r.createdInvoiceId}`);
    }
  }
  await pool.end();
}

run().catch((err) => {
  console.error('[recurring-invoices] failed:', err);
  process.exit(1);
});
