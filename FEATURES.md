# Features

What this app does, grouped by area. (Stripped-down fork of PocketLens —
see [CHANGES.md](./CHANGES.md) for what was removed vs upstream.)

## Navigation

- Simplifi-style sidebar: hamburger (top-left) opens a slide-over on
  mobile, persistent rail on desktop. Sections: Dashboard, Transactions,
  Accounts, Spending Plan, Churning, Reports, Settings.
- Notification bell with unread badge stays in the top bar.

## Auth & accounts

- Email/password sign-up and sign-in (Supabase Auth), multi-user with
  per-user RLS isolation.
- Forgot-password / reset flow via emailed recovery link.
- Link banks and credit cards through Plaid; institution logos and names
  shown per account.
- Accounts page: "All Accounts" total, collapsible Cash & Checking /
  Savings / Credit / Other groups with subtotals, per-account detail with
  recent transactions and a churning-tracker link for linked cards.
- "New" account dialog: fast manual add (name, checking/savings/credit,
  starting balance) or connect a bank with Plaid.
- Manual "separate" accounts (non-Plaid): balance ledger with add/subtract
  entries and recurring contributions.
- Quick incremental sync (cursor delta) and a full 730-day re-import
  (rate-limited by a cooldown).
- Manual refresh: tap refresh in the app and the API runs Plaid sync →
  reconcile → AI categorization → card-credit detection → notifications,
  inline, and returns a summary. No scheduler, no webhooks.
  a drift reconciler.

## Spending plan (home)

- Planned monthly income (one setting).
- Bills: name, amount, due day of month, optional category label, active
  toggle — all CRUD.
- Savings goals: name, target amount, monthly contribution — all CRUD.
- Plan math: `safe-to-spend = planned income − active bills − goal
  contributions − spent this month`, with spent-so-far progress and
  per-day remaining for the rest of the month.
- Deadlines widget: upcoming signup-bonus deadlines, card-credit expiries,
  annual-fee dates, and card cancel-by dates, soonest first.

## Transactions

- Month-navigated transaction list with per-month Spent / Income totals.
- Cross-month search (substring + typo tolerance + amount match).
- Tap-to-categorize, a categorize review queue, and bulk-categorize by
  merchant.
- Auto-categorization: per-merchant learned memory plus keyword rules
  (deterministic, always win); the Jev AI decision model then classifies the
  rest against your live categories with calibrated confidence, one Brave
  Search merchant lookup + re-classify for low-confidence items, and anything
  still unsure stays in the review queue. Repeat merchants are cached.
  One-click "Auto-categorize" of everything uncategorized on the Transactions
  page; runs automatically after every Plaid sync and CSV import. Toggle,
  provider (`jev`/`gemini`/`off`), and confidence threshold in
  Settings → AI Categorization.
- "Ignore in spending plan" flag per transaction (excluded from plan math).
- Transfers: automatic detection of paired legs across accounts so card
  payments don't inflate spending; transfer legs are excluded from totals.
- Reimbursements (contra-expense): flag an incoming credit to offset a
  category's spend rather than count as income.
- Hidden transactions: keep a row but drop it from totals.
- Recurring-charge detection (cadence + consistent amount) with confirm /
  ignore / remove.
- CSV export of the current transaction view; CSV import via the Import
  button (column mapping, bank-statement sign convention, idempotent —
  re-imports skip duplicates).

## Churning tracker

- Cards: name, issuer, last 4, opened date, annual fee + fee date, cancel-by
  date, notes, optional link to a synced Plaid account.
- Signup bonuses: description, spend required, spend window
  (defaults to card opened date → deadline), bonus value, status
  (in progress / completed / failed). Live progress bar measuring qualifying
  spend on the linked account inside the window, with remaining amount and
  days left.
- Card credits (airline, streaming, etc.): name, amount, frequency
  (annual / semiannual / monthly), reset date, notes — plus **automatic
  usage detection**: configure merchant keywords + expected amount and the
  credit marks itself used when the refund posts (money-in transaction on
  the linked account in the current cycle), with the triggering transaction
  linked; manual mark-used / unmark override always wins (unmarking blocks
  re-detection of that transaction). Credit cycles roll over automatically
  from frequency + reset date.
- "Credits needing attention" section: unused credits nearing their reset
  date (configurable "remind me N days before", default 7).
- Deadline badges on the card list; full detail per card.

## Notifications

- In-app notification center: bell icon with unread badge in the top bar,
  newest-first list, per-item and mark-all-read. Works with zero config.
- Triggers: unused credit expiring within its remind window, signup bonus
  deadline within 14 days with spend remaining, annual fee / cancel-by
  within 30 days. Each reminder is stored once per credit-period
  (or bonus/date) — no duplicate reminders.
- Per-type toggles and lead-time days in Settings → Notifications (a
  credit's own "remind me N days before" still wins when set).

## Reports

- Date presets (this/last month, last 3/6/12 months, custom range), group by
  category / merchant / account, account + category filters, toggles to
  exclude transfers and budget-ignored transactions.
- Bar chart + donut for the grouping, monthly income-vs-spending trend
  line, per-card spend table, CSV export of the current report.

## Settings

- General: display name (used in the dashboard greeting), currency
  (applied app-wide), Light / Dark / System theme, "Install app" (PWA).
- Accounts: rename, hide/unhide from totals, Plaid reconnect/disconnect,
  add-manual-account shortcut.
- Categories: add, rename, archive custom categories.
- Rules: list/add/edit/delete keyword categorization rules, incl. learned
  merchant mappings.
- Notifications: per-type toggles + lead-time days, in-app bell only.
- Data: CSV import/export shortcuts; delete-account danger row.

## Install as an app (PWA)

- "PocketLens Budget" is installable: Add to Home Screen on iOS/Android,
  standalone display, offline app shell.
- Service worker precaches the UI and fetches financial data
  network-first — balances and transactions are never served stale; Plaid
  Link flows are never cached.
- Android/desktop Chrome: tap "Install app" (banner or Settings →
  General). iPhone/iPad: open in Safari → Share → Add to Home Screen.
- Requires HTTPS (or localhost): serve the production build behind TLS —
  e.g. a public domain with a reverse proxy, or Tailscale for phone access
  on your tailnet.
