# Renewal Autopilot

A multi-tenant ServiceM8 Add-on that automates recurring-service renewal
reminders. When a job carrying a **renewal badge** (e.g. "1 year auto") is
completed, that customer enters a renewal cycle. The add-on tracks who's due
for their next service and queues a draft SMS/email for staff to review and
approve — it **never auto-sends** to a customer.

## How it works

- **Badge-driven tracking.** A ServiceM8 Badge decides what counts toward
  renewal (not job category). The three badges — "1 year auto", "3 month
  auto", "6 month auto" — are auto-created in each account on install.
- **Due detection.** A per-customer next-due date is computed from the last
  completed badged job + the rule's interval. Customers are bucketed into
  **Overdue / Due now / Due soon / Due later**.
- **Staff approval queue.** A dashboard (opened from ServiceM8's Add-ons menu
  or a job card) lists due customers with an editable SMS/email draft. Staff
  pick a channel and send — nothing goes out automatically.
- **3-round follow-ups.** Round 1 is sent manually; rounds 2 and 3 auto-draft
  as the due date approaches, unless the customer rebooks or is dismissed.
  Sent customers move into **Contacted 1 / 2 / 3**.

## Stack

Cloudflare Worker + D1 (SQLite), no build step, hand-rolled routing. Deploys
automatically from this repo via Cloudflare Workers Builds on push to
`master`. Multi-tenant: serves any ServiceM8 account that installs it.

Key modules (`src/`):

- `index.js` — router, OAuth install, webhook + cron entry points
- `due-engine.js` — due-detection, bucketing, draft + follow-up generation
- `dashboard.js` — the staff approval queue UI
- `servicem8-api.js` / `servicem8-oauth.js` — tenant-scoped ServiceM8 client
- `addon.js` — job-card / menu action JWT verification + dashboard tokens

## Setup

1. Register the App at [developer.servicem8.com](https://developer.servicem8.com)
   using `addon-manifest.json` (activation + callback URLs point at the
   deployed Worker; a public HTTPS callback is required).
2. Deploy: `npx wrangler deploy` (or push to `master` — Cloudflare builds it).
3. Install via the Worker's `/install` URL to run the OAuth flow.

## Local dev

```
npm install
cp .dev.vars.example .dev.vars   # real secrets; gitignored, never committed
npm run db:init                  # applies schema.sql to the local D1 instance
npm run dev
```
