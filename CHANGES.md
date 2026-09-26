# What changed vs upstream PocketLens

This fork starts from PocketLens
([xasifsaeedx/pocketlens-app](https://github.com/xasifsaeedx/pocketlens-app),
MIT) and strips it to a barebones Simplifi replacement. Git history is kept,
so `git log` shows the upstream baseline.

## Decisions (2026-09-26)

### Backend rebuild: AWS Lambda + manual refresh

The backend was rebuilt around **AWS Lambda + manual refresh** (user-approved
2026-09-26; ~$0/mo — Lambda free tier covers this workload indefinitely, and
there is no OS to patch). Manual refresh unlocked Lambda: it killed the two
things that made Lambda unfit — the 24/7 scheduler loop and the Plaid webhook
listener. What remains is request/response bursts (user taps refresh → one
Function URL invocation does the work), which is exactly Lambda's shape:

- **Runtime:** FastAPI on Lambda as a container image (ECR) through Mangum and
  a Lambda Function URL (`finance-backend/sync-service/lambda_handler.py`).
- **Manual refresh only:** tapping refresh in the app calls `POST /sync/trigger`,
  which runs the whole chain inline in one request — Plaid sync → reconcile →
  Jev categorization → card-credit detection → in-app notifications — and
  returns a summary. `/link/claim`, `/backfill/{item_id}`, and `/backfill-all`
  are inline too. No background tasks, no Docker Compose, no background
  processes anywhere.
- **Removed surfaces:** `POST /internal/sync`, `POST /internal/daily`, the
  `TRIGGER_SECRET` scheme, `POST /webhook/plaid` (ES256 verification +
  `register_webhooks.py`), the pg_cron jobs (`pocketlens-hourly-sync`,
  `pocketlens-daily`, `pocketlens-wake-api`, `pocketlens-keep-awake` —
  unscheduled by migration `20261019000000_disable_server_scheduler.sql`),
  and the SMTP email digest (in-app bell only).
- **Safety rails for the Lambda 15-min cap:** bounded Brave lookups per AI
  categorization run (`AI_MAX_BRAVE_LOOKUPS_PER_RUN`), a pipeline time budget
  (`AI_CATEGORIZE_TIME_BUDGET_S`), per-page Plaid cursor checkpointing, and
  per-item sync failure isolation.

### Plaid credentials / household decisions

- **Plaid credentials: server-wide.** The old per-user Plaid credentials card
  was dropped from the rebuilt Settings UI and stays out — one set of Plaid
  developer keys for the household, configured server-side. The
  `PlaidCredentialsCard.tsx` component is orphaned (backend
  `data/plaidCredentials.ts` still works); it can be deleted in a cleanup pass.
- **Greeting: household name "Dara".** The app is shared by Daniel and his wife
  Sara, so the time-of-day dashboard greeting addresses the household
  ("Good morning, Dara.") instead of one person. `handle_new_user()` now
  defaults `profiles.first_name` to `'Dara'` when signup provides no name
  (migration `20261018000000_default_greeting_name.sql`); the frontend falls
  back to "Dara" when the profile name is blank. Editable per user in
  Settings → General → Display name.

## Removed

**Backend** (`finance-backend/sync-service/`):
- `investments.py` — investment/holdings sync deleted; brokerage holdings no
  longer sync (accounts of investment type still list, holdings don't).
- `digests.py`, `alerts.py`, `push.py` — spend digests and the
  notification/alert evaluation pipeline deleted. The scheduler now runs
  `sync.py && reconcile.py` only.
- `backfill_net_worth.py` — nothing writes to `net_worth_snapshots` anymore.
  (The table and old snapshots remain in the schema, harmless.)
- Tests for the above.

**Frontend** (`web/`):
- Pages: Explore (reports), Activity (activity log/undo), old Dashboard,
  old Budgets (zero-based budgeting). Routes deleted outright.
- Net worth: header, trend charts, `netWorth.ts`, snapshots UI.
- Spending reports / breakdown charts / saved views.
- Tags (dialogs, chips, tag→category rules), transaction splits,
  manual transfer-linking dialog (automatic transfer *detection* in the
  backend is kept — it keeps card payments out of spend totals).
- Notification center + preferences, feedback dialog.
- Demo mode on the logged-out home (now a plain login wall).
- Zero-based budgeting: `ZbbBudgetView`, ZBB settings card, rollover logic UI.
  (The ZBB tables remain in the schema, unused.)

## Reshaped

- **Budgets → Spending plan.** The home page is now a Simplifi-style spending
  plan: planned monthly income − active bills − savings-goal contributions −
  month-to-date spending = **safe-to-spend**, with per-day remaining.
  New tables: `spending_settings`, `bills`, `savings_goals`
  (migration `20261001000000_spending_plan_and_churning.sql`).
- Transactions gained an **"ignore in spending plan"** toggle backed by the
  existing `transactions.exclude_from_totals` column.
- **CSV import UI added**: the parser (`lib/csv.ts`) and insert logic
  (`importTransactions`) existed upstream but the import page was disabled;
  this fork adds `CsvImportDialog` on the Transactions page (column mapping,
  sign-convention toggle, idempotent upserts).

## Added (round 4 — AI transaction categorization with Jev)

- **Provider-swappable AI categorization** (`finance-backend/sync-service/ai_categorize/`).
  `ClassifierProvider` is the swap point: `JevProvider` (TypeSafe Jev decision
  model via the direct System One API — Choice questions over the user's live
  category list, ~10 transactions per call, calibrated confidence) plus a clean
  `GeminiProvider` stub. `AI_CLASSIFIER_PROVIDER=jev|gemini|off` (env default,
  per-user override in Settings).
- **Fixed pipeline order:** learned merchant memory + keyword rules first
  (deterministic, always win — user corrections keep teaching them), then the
  merchant cache, then Jev, then one Brave Search merchant lookup
  (`BRAVE_API_KEY`) + re-classify for below-threshold verdicts; still-unsure
  items stay in the review queue. `AI_CONFIDENCE_THRESHOLD` default 0.7.
- **Triggers:** automatically after every Plaid sync/webhook (`_finalize_user`,
  best-effort — can never break a sync), after CSV import (best-effort
  `POST /categorize/auto` from the import dialog), and on demand via the
  "Auto-categorize" button on the Transactions page.
- **Cache:** `ai_category_cache` (unique per user + normalized merchant, RLS
  own-rows); repeat merchants never re-call the model. Transactions record
  `ai_confidence` / `ai_source` so AI verdicts are distinguishable.
- **Settings → AI Categorization:** enable toggle, provider select, confidence
  threshold, API-key *presence* only (keys stay in env). `GET /categorize/status`.
- **Tests:** 21 mocked unit tests (`tests/test_ai_categorize.py`) covering
  rules precedence, batching, thresholds, search/retry, provider swapping,
  cache hits, and never-raise behavior; plus a credential-gated live Jev
  smoke test that skips cleanly without `JEV_API_KEY`.
- New migration `20261017000000_ai_categorization.sql` (profile prefs, cache
  table, transaction provenance columns). New env vars documented in README
  and `.env.example`.

## Added (round 3 — sidebar nav, accounts, reports, settings, PWA)

- **Simplifi-style sidebar navigation.** The old top-tab bar and mobile
  bottom capsule are gone: a hamburger (top-left) opens a slide-over
  sidebar on mobile and a persistent rail on desktop. Order: Dashboard,
  Transactions, Accounts, Spending Plan, Churning, Reports, Settings.
  Dashboard and Spending Plan render the same home page (the spending plan
  IS this app's dashboard); `/spending-plan` is a route alias so each entry
  keeps its own highlight. The notification bell stays in the top bar.
- **Accounts page rebuilt** (`/accounts`): "All Accounts" total (assets −
  liabilities, credit shown negative like Simplifi), a "Balance with
  pending" note, "See All Transactions", and a "New" button opening a
  two-choice dialog — a fast 3-field manual add (name, checking/savings/
  credit, starting balance, one-tap save) or "Connect bank with Plaid"
  (→ Settings bank setup). Collapsible Cash & Checking / Savings / Credit /
  Other groups with subtotals; chevron rows open the account detail (balance
  header, recent transactions, and a "View in churning tracker" link on
  credit cards linked to a churn card).
- **Reports** (`/reports`): date presets (this/last month, 3/6/12 months,
  custom), group-by category/merchant/account, account + category filters,
  toggles to exclude transfers and budget-ignored transactions; bar chart +
  donut for the grouping, monthly income-vs-spending trend line, per-card
  spend table, CSV export of the current report. Aggregation helpers live in
  `web/src/lib/reports.ts` with vitest coverage.
- **Settings rebuilt** as six Simplifi-style list sections: General
  (display name — shown in the dashboard greeting — currency, theme),
  Accounts (rename, hide/unhide from totals, Plaid reconnect/disconnect,
  manual-add shortcut), Categories (add/rename/archive via new
  `categories.is_active`), Rules (add/edit/delete, incl. learned merchant
  mappings), Notifications (per-type toggles + lead-time days for credit /
  bonus / fee reminders, email-digest opt-in with SMTP note), Data (CSV
  import/export shortcuts). Preferences persist in `profiles` (migration
  `20261016000000_settings_preferences.sql`); `notify.py` now honors the
  per-type enable/lead-time prefs (a credit's own `remind_days_before`
  still wins when set). The currency pref is applied app-wide through
  `setDefaultCurrency` in `web/src/lib/money.ts`.
- **PWA support** (`vite-plugin-pwa`, Workbox): installable "PocketLens
  Budget" app (standalone display, maskable icons generated from the lens
  brand mark). The service worker precaches the app shell and uses
  network-first for Supabase/FastAPI calls — financial data is never served
  stale; Plaid Link flows are never cached. `beforeinstallprompt` banner +
  "Install app" row in Settings → General; iOS shows Share → Add to Home
  Screen instructions. Requires HTTPS (or localhost) — see README.
- **Plaid sandbox E2E test** (`tests/test_plaid_sandbox_e2e.py`, marked
  `integration`, skipped without creds): link token → First Platypus Bank
  sandbox public token → exchange → multi-account import → cursor sync with
  account linkage → second item → synthetic `SYNC_UPDATES` webhook. Run
  with `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV=sandbox`.

## Added (round 2 — credit auto-detection & notifications)

- **Automatic credit-usage detection.** `churn_credits` gained detection
  config columns (`auto_detect`, `detect_merchant_keywords`,
  `detect_amount`, `detect_tolerance`, `remind_days_before`) and detection
  state (`used_at`, `detected_transaction_id`, `detection_source`
  auto/manual, `detection_dismissed_transaction_ids`, `period_start_date`).
  New `credit_detector.py` runs after every Plaid sync/webhook (hooked into
  `_finalize_user`) and after CSV import (via new `POST /credits/detect`
  endpoint): it scans the card's linked account for money-in transactions in
  the current cycle matching the merchant keywords and expected amount, and
  marks the credit used with the triggering transaction linked. Credit cycles
  roll over automatically from frequency + reset date. Manual mark/unmark
  always wins; unmarking blocks re-detection of that transaction.
  Migration `20261015000000_credit_autodetect_and_notifications.sql`.
- **Notification center.** In-app bell with unread badge, newest-first list,
  mark-read / mark-all-read (new `notifications` table, deduped per
  credit-period / bonus / date so reminders never repeat). Triggers: unused
  credit expiring within its remind window, bonus deadline within 14 days
  with spend remaining, annual fee / cancel-by within 30 days. New
  `notify.py` scheduler job (runs after sync + reconcile, and via
  `/internal/daily`); optional SMTP email digest with per-user opt-in
  (`profiles.notify_email_enabled`).
- Credit expiries added to the deadlines widget and a new "Credits needing
  attention" section on the churning page.

## Added (round 1)

- **Churning tracker** (`/churning`): cards (issuer, opened date, annual fee,
  cancel-by date, linked Plaid account), signup bonuses with live
  spend-progress bars measured from the linked account's transactions inside
  the bonus window, per-card credits (amount, frequency, used/remaining,
  reset date), and a deadlines widget on the spending-plan dashboard sorting
  bonus deadlines, annual fees, and cancel-by dates by urgency.
  New tables: `churn_cards`, `churn_bonuses`, `churn_credits`.

## Kept as-is

Plaid Link flow (incl. OAuth update mode), cursor-based transaction sync,
per-user or server-wide Plaid credentials (Fernet-encrypted), Plaid webhooks,
scheduled sync + reconcile, balance history, accounts (Plaid + manual
"separate" accounts), month-navigated transactions, search, tap-to-categorize,
categorize review queue, bulk-categorize by merchant, learned + keyword
auto-categorization rules, recurring-charge detection, transfer
auto-detection, reimbursements, hidden transactions, CSV export, categories
+ rules management, Supabase Auth + RLS multi-user model, light/dark theme.
