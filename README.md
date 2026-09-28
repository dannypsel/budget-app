# Barebones Budget — a stripped-down Simplifi replacement

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A self-hosted, barebones budgeting app: a Simplifi-style **spending plan**,
**transactions with auto-categorization**, **Plaid bank sync**, and a
**credit-card churning tracker** with automatic credit-usage detection and
expiry reminders. Nothing else — no investment tracking, no net
worth charts, no reports suite, no spend-digest spam.

**This is a fork of [PocketLens](https://github.com/xasifsaeedx/pocketlens-app)**
by xasifsaeedx and contributors, used under the MIT License (see
[LICENSE](./LICENSE), unchanged). PocketLens did the hard parts — Plaid Link,
cursor-based transaction sync, the rules-based categorizer, and the
Supabase data layer — and this fork strips it to the essentials, reshapes
budgets into a spending plan, and adds the churning tracker. Thank you to the
PocketLens authors.

What changed vs upstream is documented in [CHANGES.md](./CHANGES.md); the
current feature list is in [FEATURES.md](./FEATURES.md).

## The four features

1. **Spending plan** (home dashboard, Simplifi-style): set a planned monthly
   income, add recurring bills (name, amount, due day), add savings goals with
   monthly contributions. The plan computes
   `safe-to-spend = income − bills − goal contributions − spent this month`
   and shows what's left per day for the rest of the month. Transactions can be
   flagged "ignore in spending plan".
2. **Transactions + categorization**: month-navigated list, search, tap-to-
   categorize, bulk-categorize by merchant, auto-categorization from learned
   merchant memory + keyword rules you manage, recurring-charge detection.
3. **Plaid import**: link banks/credit cards through Plaid Link, cursor-based
   sync triggered manually from the app (tap refresh). Balances included.
   CSV import/export as a fallback when Plaid isn't available.
4. **Churning tracker**: track each card (issuer, opened date, annual fee,
   cancel-by date, linked Plaid account), signup bonuses with live
   spend-progress bars against the bonus window, per-card credits
   (airline/streaming/etc.) with **automatic usage detection** — when the
   credit posts back to the card (e.g. the $20 Grubhub credit on Amex Gold
   Business), the credit is marked used for the month on its own — plus
   manual mark/unmark override, and **notifications** (in-app bell) reminding
   you before credits expire, bonuses lapse, or
   annual fees / cancel-by dates arrive. A deadlines widget surfaces bonus
   deadlines, credit expiries, annual fees, and cancel-by dates by urgency.

Also in this build:

- **Sidebar navigation** (Simplifi-style): hamburger opens a slide-over on
  mobile, persistent rail on desktop — Dashboard, Transactions, Accounts,
  Spending Plan, Churning, Reports, Settings.
- **Accounts page**: "All Accounts" total with collapsible Cash & Checking /
  Savings / Credit / Other groups, per-account detail, and a "New" dialog
  with a fast 3-field manual add or Plaid connect.
- **Reports**: customizable spending reports (date range, group by
  category/merchant/account, filters, income-vs-spend trend, per-card spend
  table, CSV export).
- **Settings**: six-section list — General (display name, currency, theme),
  Accounts, Categories, Rules, Notifications (per-type toggles + lead times),
  Data.
- **PWA**: installable "PocketLens Budget" app — see below.

## Stack

React + TypeScript web app (Vite), Python (FastAPI) sync service, Supabase
(Postgres + Auth + row-level security). The web app reads/writes Postgres
directly through Supabase's API and only calls the sync service to link a bank
or trigger a sync.

```
┌────────────┐   Plaid SDK    ┌─────────────────────┐   supabase-py    ┌──────────────┐
│   Plaid    │ ─────────────► │  Python sync service │ ───────────────► │   Supabase   │
│  banks +   │                │  (AWS Lambda,         │                  │  Postgres +  │
│   cards    │                │   Function URL)       │                  │  Auth + RLS  │
└────────────┘                └─────────────────────┘                  └──────────────┘
                                        ▲                               └──────┬───────┘
                                        │ POST /sync/trigger            │ supabase-js
                                 ┌──────┴───────────────────────────────┐      ▼
                                 │      Browser web app (React/Vite)     │ ◄────┘
                                 └───────────────────────────────────────┘
```

## Requirements

- **Supabase** for data storage (see below).
- A [Plaid](https://dashboard.plaid.com/signup) account for bank sync
  (optional — CSV import works without it).
- The [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
  to apply the migrations under `finance-backend/supabase/migrations/`.

### Data storage

Your data lives in Postgres, but the app also relies on Supabase's Auth
(login), row-level security (each user only sees their own data), and
PostgREST (the API the web app talks to). Recommended: **Supabase Cloud**
(free tier — enough for a household budget app; create one project for prod
and one for local dev). Self-hosting Supabase with Docker is also possible —
see [Supabase self-hosting](https://supabase.com/docs/guides/self-hosting/docker).
Free Cloud projects pause after a week of inactivity; regular use (or a
manual unpause in the dashboard) keeps them alive.

Pointing the app at a plain Postgres server (RDS, Neon, bare `postgres`
container) does **not** work — login and data access go through the Supabase
components.

## Quickstart (local)

No Docker, no AWS — just `uvicorn` + `vite dev`, pointed at a Supabase Cloud
dev project with all migrations applied.

```bash
git clone <your-fork-url> && cd self-hosted-budget
cd web && npm ci && cd ..                 # install web deps
cd finance-backend
supabase link --project-ref <dev-project-ref>   # your Cloud dev project
supabase db push                          # apply migrations
cd ..
cp finance-backend/sync-service/.env.example finance-backend/sync-service/.env
# …fill in SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY (dev project API settings)
./scripts/local-dev.sh                    # uvicorn :8000 + vite :5173
```

Open the web app at <http://localhost:5173> (sync-service API on `:8000`).

## Install as an app (PWA)

The web build is an installable PWA ("PocketLens Budget", standalone
display, maskable icons). The service worker precaches the app shell and
fetches all financial data network-first — balances and transactions are
never served stale, and Plaid Link flows are never cached.

- **Android / desktop Chrome:** tap "Install app" in the dismissible banner
  or in Settings → General.
- **iPhone / iPad:** open the app in Safari → Share → Add to Home Screen
  (iOS doesn't offer the automatic install prompt).
- **HTTPS required:** service workers only run on HTTPS or localhost. In
  production the app is served from CloudFront (HTTPS built in), so install
  it from your CloudFront URL — no reverse proxy or VPN needed to reach the
  backend from your phone. `VITE_BACKEND_URL` is baked into the build, so
  rebuild after changing it.

## Production (Supabase Cloud + AWS Lambda)

You need a Supabase Cloud project with the migrations applied:

```bash
cd finance-backend
supabase link --project-ref <your-project-ref>   # or --db-url for self-hosted
supabase db push
```

The Lambda deploy itself (ECR image build, Function URL, CloudFront) is
documented in `deploy/SETUP.md`.

### Environment variables

Sync service (`finance-backend/sync-service/.env`):

| Variable | Required | What it is |
|---|---|---|
| `SUPABASE_URL` | yes | Supabase project URL. |
| `SUPABASE_SECRET_KEY` | yes | Service-role key. Server-side only — bypasses RLS. |
| `CREDENTIALS_ENC_KEY` | yes | Fernet key encrypting Plaid secrets + access tokens at rest. Keep it safe — losing it orphans every stored secret. Generate: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `WEB_ORIGINS` | yes | Comma-separated CORS allowlist for the web app, scheme included. On AWS Lambda this must include the CloudFront origin serving the web app. |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` | no | Server-wide Plaid credentials for the household (the only Plaid credentials — the per-user credentials card was removed). |
| `PLAID_REDIRECT_URI` | no | The API's own `…/link` URL, for OAuth banks (Chase, Bank of America, …). Allowlist it in the Plaid dashboard. |
| `PLAID_ITEM_LIMIT` | no | Max active Items per Plaid account (default 10). |
| `FULL_SYNC_COOLDOWN_DAYS` | no | Cooldown between user-triggered full syncs (default 2). |
| `AI_CLASSIFIER_PROVIDER` | no | AI classifier: `jev` (default), `gemini` (stub), or `off`. Per-user override in Settings → AI Categorization. |
| `JEV_API_KEY` | no | Jev (TypeSafe) API key — <https://typesafe.ai>. `TYPESAFE_API_KEY` also accepted. Without it, AI classification is skipped gracefully. |
| `JEV_MODEL` | no | Jev model alias (default `jev-latest`). |
| `JEV_API_URL` | no | Jev API endpoint override (default `https://api.typesafe.ai/v1/systemone`). Point at OpenRouter's System One endpoint to use an OpenRouter key — see "AI transaction categorization". |
| `AI_CONFIDENCE_THRESHOLD` | no | Default confidence threshold 0–1 (default 0.7). Per-user override in Settings. |
| `BRAVE_API_KEY` | no | Brave Search key for merchant enrichment of low-confidence verdicts. Without it, those items go to the review queue. |
| `AI_MAX_TXNS_PER_RUN` | no | Max transactions classified per pipeline run (default 200). |

Web build (root `.env`, baked in at build time — public, no secrets):

| Variable | What it is |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (`sb_publishable_...`). |
| `VITE_BACKEND_URL` | Sync-service API URL. |
| `VITE_API_BASE_URL` | Same API URL. |

There is no scheduler: `POST /sync/trigger` runs `sync.py` (incremental
Plaid sync), then `reconcile.py` (drift healing), then `notify.py`
(credit/bonus/fee in-app reminders) inline and returns a summary. The old
pg_cron jobs (`pocketlens-hourly-sync`, `pocketlens-daily`, …) are unscheduled
by migration `20261019000000_disable_server_scheduler.sql`.

## Plaid setup

1. Create an account at <https://dashboard.plaid.com/signup> and get a
   **Client ID** and **Secret** (start in Sandbox — it's free and works
   end-to-end with test banks).
2. Put them in `finance-backend/sync-service/.env` as `PLAID_CLIENT_ID`,
   `PLAID_SECRET`, `PLAID_ENV=sandbox` (or let each user add their own in
   Settings → Plaid — per-user secrets are validated and stored encrypted).
3. For OAuth banks (Chase, BofA, …): set `PLAID_REDIRECT_URI` to your API's
   public `/link` URL and allowlist that URI in the Plaid dashboard.

**Honest cost note:** Plaid's production pricing is per connected institution
("Item") per month plus API-call metering, and moving to Production requires
Plaid to approve your use case (can take days/weeks, plus OAuth institutions
may need registration). Sandbox is free for testing. If you'd rather skip
Plaid entirely, the app works fully manual with CSV import — see below. A
flat-rate alternative some self-hosters use is SimpleFIN (~$15/year).

## Credit auto-detection & notifications

**How auto-detection works.** Each card credit can carry detection settings:
merchant keywords (e.g. `grubhub`), the expected credit amount (e.g. `20.00`),
and a match tolerance. After every Plaid sync — and after every CSV import —
the backend scans the card's linked account for money-*in* transactions
(Plaid posts refunds/credits as negative amounts) in the current credit
cycle whose merchant matches a keyword and whose amount matches the expected
value. On a match the credit is marked used for the cycle automatically,
with the matched transaction linked so you can see exactly what triggered it.
You can always override: manually mark a credit used, or unmark an
auto-detected one — unmarking remembers that transaction so it won't be
re-detected. Cycles roll over on their own from the frequency + reset date.

**Notifications.** The bell icon in the top bar shows unread reminders,
newest first, with mark-read / mark-all-read. Triggers: an unused credit
whose cycle ends within its "remind me N days before" window (default 7), a
signup bonus deadline within 14 days with spend still remaining, and annual
fee / cancel-by dates within 30 days. Each reminder is stored once per
credit-period (or bonus/date), so you never get the same reminder twice.

## AI transaction categorization

**How it works.** After every Plaid sync and every CSV import — plus on demand
via the "Auto-categorize" button on the Transactions page — the backend runs
a fixed pipeline:

1. **Your rules always win.** Learned merchant memory and keyword rules run
   first (deterministic, free). Correcting a category teaches the memory, and
   the AI can never override it.
2. **Jev classifies the rest.** The TypeSafe Jev decision model picks from
   *your live category list* (Choice questions, batched ~10 per call) and
   returns a calibrated confidence per transaction.
3. **Low confidence → one lookup.** Below your threshold (default 70%) the
   backend does a single Brave Search merchant lookup and re-classifies once
   with the enriched description.
4. **Still unsure → review queue.** Anything still below threshold stays
   uncategorized, in the existing "to categorize" review flow.

A per-merchant cache (`ai_category_cache`) means repeat merchants never
re-call the model. Applied verdicts are recorded (`ai_confidence`,
`ai_source`) so AI-applied categories are distinguishable from rule-applied
ones. The pipeline never raises — a dead key or flaky network is logged and
counted, never breaks a sync or import.

**Setup (direct TypeSafe).** Get an API key at <https://typesafe.ai> and set
`JEV_API_KEY` on the sync service. That's it — `JEV_MODEL` defaults to
`jev-latest`.

**Setup (via OpenRouter).** Jev is also served on OpenRouter (model
`typesafe/jev-1.13`, see <https://openrouter.ai/docs/guides/community/jev>).
Set `JEV_API_KEY` to your OpenRouter key, `JEV_MODEL=typesafe/jev-1.13`, and
`JEV_API_URL=https://openrouter.ai/api/v1/systemone`.

**Brave Search.** Get a free key at <https://brave.com/search/api/> and set
`BRAVE_API_KEY`. Optional — without it, low-confidence items just go to
review.

**Swapping providers.** `AI_CLASSIFIER_PROVIDER=jev|gemini|off` (env default;
per-user in Settings → AI Categorization). The `ClassifierProvider` interface
(`ai_categorize/providers.py`) is the swap point — `gemini` is a clean stub
waiting on an implementation. Keys stay in env vars, never in the database;
Settings shows key *presence* only.

**Cost.** Jev is a decision model, not a chatbot: each classification is a
short input (merchant, amount, your category list) with free outputs.
Expect roughly fractions of a cent per ~1,000 short classification inputs at
current list pricing — check <https://typesafe.ai> for the latest numbers.

## CSV import / export

- **Export**: on the Transactions page, "Export CSV" downloads the current
  view. The format round-trips through the importer.
- **Import**: on the Transactions page, "Import CSV" opens a dialog: pick a
  synced account, choose the file, map the Date / Amount / Merchant columns
  (auto-guessed), and choose whether spending is shown as negative (typical
  bank export). Rows are parsed in your browser and inserted with idempotent
  keys, so re-importing the same file skips duplicates instead of
  double-counting.

## Backup

Everything lives in your Supabase Postgres. Back it up with `pg_dump` against
your database (or Supabase's built-in backups on hosted projects). The Plaid
access tokens are encrypted with `CREDENTIALS_ENC_KEY` — **back up that key
with the database**; losing it orphans every linked bank and you'll have to
re-link.

## Repository layout

| Path | What |
|---|---|
| `web/` | React + Vite + TypeScript web app |
| `web/src/pages/SpendingPlanPage.tsx` | Spending plan dashboard (home) |
| `web/src/pages/ChurningPage.tsx`, `ChurnCardDetailPage.tsx` | Churning tracker |
| `finance-backend/sync-service/` | Python FastAPI API + Plaid sync / reconcile jobs |
| `finance-backend/supabase/migrations/` | Postgres migrations (fresh-DB safe; `20261001000000_*` adds the spending-plan + churning tables) |
| `scripts/` | Local full-stack dev helpers |

## Tests

```bash
cd web && npx tsc -b && npx vitest run          # type-check + unit tests
cd finance-backend/sync-service && pytest -m "not integration"
```

## License

Released under the [MIT License](./LICENSE) — the original PocketLens license,
kept intact. This fork's changes are documented in [CHANGES.md](./CHANGES.md).
