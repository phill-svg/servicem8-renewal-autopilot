# Renewal Autopilot

A ServiceM8 Add-on: tracks each customer's last completed service per Job
Category, flags who's due for their next recurring service (quarterly pest
treatment, annual termite inspection, HVAC filter change, fire-safety
inspection, etc.), and queues a draft SMS/email reminder for staff to review
and approve -- never auto-sends to a customer.

Full design/rationale: `C:\Users\Phill\.claude\plans\scalable-painting-beacon.md`

## Stack

Cloudflare Worker + D1, no build step, hand-rolled routing -- same
conventions as `../tcbpestcontriol` and `../tcb-customer-portal`. Multi-tenant
from day one: this serves any ServiceM8 account that installs it, not just
TCB Pest Control.

## Status

Phase 0/1 in progress -- see the plan doc and the task list for current state.
Requires registering an App at developer.servicem8.com before the OAuth2 /
webhook flows can be exercised for real (public HTTPS callback required,
`wrangler dev` alone isn't sufficient for that part).

## Local dev

```
npm install
cp .dev.vars.example .dev.vars   # fill in real values once the App is registered
npm run db:init                  # applies schema.sql to the local D1 instance
npm run dev
```
