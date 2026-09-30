// Domain types for OUR Supabase schema (UUID ids), mirroring PocketLens/Models/*.swift.
// These are distinct from Keep's original int-id `types/*` (which still back Keep's
// unported pages). New Supabase-backed code imports from here.

export type UUID = string

/** category_groups row — a named container for categories (0 or 1 group per category). */
export interface CategoryGroup {
  id: UUID
  name: string
  color?: string // hex, e.g. "#0055D5"
  sort_order: number
  created_at?: string | null
}

/** categories row. `icon` is an SF Symbol name (mapped to lucide in lib/iconMap). */
export interface Category {
  id: UUID
  name: string
  color: string // hex, e.g. "#34C759"
  icon: string // SF Symbol name, e.g. "cart.fill"
  parent_id: UUID | null
  group_id: UUID | null // optional membership in a category_group
  sort_order: number
  kind: 'spend' | 'income'
  /** False when the user archived the category; undefined on rows read before
   *  the is_active migration. */
  is_active?: boolean
}

/** tags row. `color` is hex, rendered inline like category colors. */
export interface Tag {
  id: UUID
  name: string
  color: string // hex, e.g. "#8E8E93"
  created_at?: string | null
}

/** transaction_tags join row embedded via select("..., transaction_tags(tag_id, tags(*))"). */
export interface TransactionTag {
  tag_id: UUID
  tags: Tag | null
}

/** transaction_splits row, with the embedded category. Same sign convention as the txn. */
export interface TransactionSplit {
  id: UUID
  transaction_id: UUID
  category_id: UUID
  amount: number
  categories?: Category | null // embedded relation
}

/** transactions row, with the embedded category from select("*, categories(*)"). */
export interface Transaction {
  id: UUID
  plaid_transaction_id: string
  account_id: UUID
  date: string // yyyy-MM-dd
  authorized_date: string | null
  effective_date: string // generated = coalesce(authorized_date, date)
  amount: number // POSITIVE = spend, NEGATIVE = income
  merchant_name: string | null
  description: string | null
  plaid_category: string | null
  plaid_category_detail: string | null
  category_id: UUID | null
  notes: string | null
  pending: boolean
  exclude_from_totals: boolean
  transfer_group_id: UUID | null // non-null = one leg of a linked transfer
  transfer_kind: 'auto' | 'manual' | 'one_sided' | null // provenance; set iff grouped
  transfer_opt_out: boolean // user said "not a transfer" — auto-detection skips it
  hidden: boolean // user-hidden: kept but not counted (exclude_from_totals follows it)
  is_reimbursement: boolean // contra-expense: a credit that nets down its category's spend
  // Plaid-owned merchant location + settlement currency. All nullable —
  // Plaid omits them for many txns, and rows predating the feature stay null until a
  // re-sync. Forward-only groundwork for trip tagging (region) + foreign-txn detection.
  merchant_city: string | null
  merchant_region: string | null
  merchant_country: string | null
  merchant_postal_code: string | null
  merchant_store_number: string | null
  merchant_lat: number | null
  merchant_lon: number | null
  iso_currency_code: string | null // e.g. "USD", "EUR"; non-USD ⇒ foreign transaction
  need_want: NeedWant | null // auto-filled by the backend for new syncs; manual override remembered per merchant
  spend_pattern: SpendPattern | null // fixed vs variable; same auto-fill/override behavior
  categories?: Category | null // embedded relation
  transaction_tags?: TransactionTag[] | null // embedded relation
  transaction_splits?: TransactionSplit[] | null // embedded relation
}

/** Flatten embedded transaction_tags into a Tag[] (drops any null joins). */
export function txnTags(t: Transaction): Tag[] {
  return (t.transaction_tags ?? []).map((tt) => tt.tags).filter((x): x is Tag => x != null)
}

export function txnSplits(t: Transaction): TransactionSplit[] {
  return t.transaction_splits ?? []
}

export function hasSplits(t: Transaction): boolean {
  return (t.transaction_splits?.length ?? 0) > 0
}

/** True when the txn is linked into a transfer group (excluded from totals). */
export function isTransfer(t: Transaction): boolean {
  return t.transfer_group_id != null
}

/** True when the txn is a reimbursement (contra-expense): an incoming credit flagged to
 *  offset a category's spend rather than count as income. */
export function isReimbursement(t: Transaction): boolean {
  return t.is_reimbursement
}

/** "City, Region" from Plaid's merchant location (whichever parts resolved), else null.
 *  Mirrors iOS Transaction.merchantLocationText. */
export function merchantLocation(t: Transaction): string | null {
  const parts = [t.merchant_city, t.merchant_region].filter(
    (p): p is string => p != null && p !== '',
  )
  return parts.length > 0 ? parts.join(', ') : null
}

/** True when the settled currency is present and not USD — marks a foreign transaction.
 *  Mirrors iOS Transaction.isForeignCurrency. */
export function isForeignCurrency(t: Transaction): boolean {
  const code = t.iso_currency_code
  return code != null && code !== '' && code.toUpperCase() !== 'USD'
}

/** Plaid PFC primary categories that mean "money moving between accounts", not
 *  earned income — a credit tagged one of these is a transfer leg (e.g. a
 *  self-deposit from another bank), never income. Mirrors sync-service
 *  transfers.py `PFC_TRANSFER`. A one-sided transfer whose counterpart isn't
 *  linked stays visible in the list but must not inflate the income figure. */
const PFC_TRANSFER = new Set(['TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS'])

/** True when this credit is a transfer leg by Plaid's category, not real income.
 *  Blacklist (not an INCOME whitelist) on purpose: legacy rows ingested before the
 *  plaid_category migration have a null category and are real income we must keep. */
export function isTransferCategory(t: Transaction): boolean {
  return t.plaid_category != null && PFC_TRANSFER.has(t.plaid_category)
}

/** Month income = Σ|amount| of credit rows (amount < 0), EXCLUDING reimbursements (a
 *  reimbursement is a contra-expense, not income) and inter-account transfer legs (a
 *  self-deposit is your own money moving, not earnings — Plaid tags it TRANSFER_IN).
 *  Pass already-counted (non-excluded) rows.
 *  The single source of truth for the reimbursements totals contract. */
export function sumIncome(txns: Transaction[]): number {
  return txns
    .filter((t) => t.amount < 0 && !t.is_reimbursement && !isTransferCategory(t))
    .reduce((s, t) => s + Math.abs(t.amount), 0)
}

/** Month net spend = Σ positive spend (non-reimbursement) − Σ reimbursement credit
 *  magnitudes. A reimbursement nets its category's spend down instead of counting as income.
 *  Pass already-counted (non-excluded) rows. Mirrors the
 *  `category_spend` view's netting, at the whole-month grain. */
export function sumNetSpend(txns: Transaction[]): number {
  return txns.reduce((s, t) => {
    if (t.is_reimbursement) return s - Math.abs(t.amount)
    return t.amount > 0 ? s + t.amount : s
  }, 0)
}

// Spend-per-category lives ONLY in the `category_spend` Postgres view now (the
// cross-client source of truth, tested in test_integration.py). Clients read it via
// data/transactions.fetchSpendByCategory / hooks.useSpendByCategory instead of
// re-summing txns client-side, so the splits+reimbursement netting rule can't drift.

export interface Account {
  id: UUID
  plaid_account_id: string
  plaid_item_id: UUID | null
  name: string
  official_name: string | null
  type: string // depository | credit | investment | loan
  subtype: string | null
  mask: string | null
  currency: string
  is_active: boolean
  display_order: number
  // client-only, filled from account_balance_history
  currentBalance?: number | null
}

/** budget_limits row — an effective-dated monthly limit. `monthly_limit` of 0 means the
 *  category is explicitly unbudgeted from `effective_month` onward. The limit in effect for a
 *  category at month M is the row with the greatest effective_month ≤ M (see data/budgets.ts). */
export interface BudgetLimit {
  id: UUID
  user_id?: UUID
  category_id: UUID
  effective_month: string // "yyyy-MM-dd", first of month
  monthly_limit: number
}

/** group_budget_limits row — same effective-dating contract as BudgetLimit but keyed on
 *  group_id. The limit for a group at month M = row with greatest effective_month ≤ M;
 *  monthly_limit 0 = explicitly unbudgeted sentinel. See data/groupBudgets.ts. */
export interface GroupBudgetLimit {
  id: UUID
  user_id?: UUID
  group_id: UUID
  effective_month: string // "yyyy-MM-dd", first of month
  monthly_limit: number
}

// ── Zero-sum (zero-based) budgeting — Supabase row shapes. Math lives in lib/zbb.ts. ──
export interface ZbbSettings {
  id?: UUID
  enabled: boolean
  rollover_mode: 'strict' | 'flexible'
  monthly_income: number
  budget_start_year: number | null
  budget_start_month: number | null
}

export interface NetWorthSnapshot {
  id: UUID
  date: string // yyyy-MM-dd
  total_assets: number
  total_liabilities: number
  net_worth: number
}

/** From the current_net_worth view (live, not a snapshot). */
export interface CurrentNetWorth {
  net_worth: number
  total_assets: number
  total_liabilities: number
  as_of: string | null // yyyy-MM-dd, newest active-account balance date
}

export interface PlaidItem {
  id: UUID
  plaid_item_id: string
  institution_id: string | null
  institution_name: string | null
  institution_logo: string | null // base64 PNG from Plaid institutions/get_by_id
  last_synced_at: string | null
  is_active: boolean
  is_syncing: boolean // per-item sync lock — true while a sync is in flight
  sync_started_at: string | null // when the current/last sync acquired the lock
  last_backfill_at: string | null // last full (730d) sync; gates the cooldown
}

/** Money-flow filter on a rule. Sign convention (see Transaction.amount): amount
 *  POSITIVE = spend/outflow, NEGATIVE = money-in/inflow. So 'in' ⇔ amount < 0,
 *  'out' ⇔ amount > 0, null ⇔ either. */
export type RuleDirection = 'in' | 'out'

export interface CategoryRule {
  id: UUID
  keyword: string
  category_id: UUID | null
  // Conditional matching. All null/false on legacy rows, which then behave
  // exactly like the old keyword→category rules. A rule fires when ALL present
  // conditions pass; on a match it sets the category (if category_id) and/or flags
  // the row as a reimbursement (if set_reimbursement).
  direction: RuleDirection | null // null = any direction
  min_amount: number | null // inclusive lower bound on ABS(amount)
  max_amount: number | null // inclusive upper bound on ABS(amount)
  set_reimbursement: boolean
}

/** tag_category_rules row. Attaching `tag_id` to a txn sets its category to
 *  `category_id`. Unique per (user, tag), so re-adding a tag's rule replaces its category. */
export interface TagCategoryRule {
  id: UUID
  tag_id: UUID
  category_id: UUID
}

export interface SeparateAccount {
  id: UUID
  name: string
  type: string // depository | investment | other = asset; credit | loan = liability
  currency: string
  is_active: boolean
  display_order: number
  currentBalance?: number // client-only (sum of values)
}

export interface SeparateAccountValue {
  id: UUID
  separate_account_id: UUID
  date: string
  amount: number // signed delta
  note: string | null
}

export interface RecurringContribution {
  id: UUID
  separate_account_id: UUID
  delta_balance: number
  frequency_in_days: number
  anchor_date: string
  last_applied_date: string | null
  is_active: boolean
}

/** A saved transactions-list filter set. `params` is client-owned (see data/savedViews.ts). */
export interface SavedView {
  id: UUID
  name: string
  params: SavedViewParams
  created_at?: string | null
}

/** Filter state captured by a saved view. Mirrors AllTransactionsPage filters. */
export interface SavedViewParams {
  categoryIds: UUID[]
  tagIds: UUID[]
}

// ── Activity log + Undo — shared cross-client contract (iOS + web write the same
//    rows; `before`/`after` JSON shapes are identical on both clients). See
//    ACTIVITY_SPEC.md / migration 20260704012616_activity_log.sql. ─────────────
export type ActivityActionType =
  | 'categorize'
  | 'hide'
  | 'unhide'
  | 'set_budget'
  | 'delete_budget'
  | 'add_rule'
  | 'delete_rule'

export type ActivityEntityType = 'transaction' | 'budget' | 'category_rule'

/** One activity_log row. `before`/`after` carry the minimal JSON needed to display
 *  and reverse the action; their exact shapes per action_type are the cross-client
 *  contract in ACTIVITY_SPEC.md. */
export interface ActivityEntry {
  id: UUID
  created_at: string // ISO timestamp
  action_type: ActivityActionType
  entity_type: ActivityEntityType
  entity_id: UUID | null
  summary: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  reversible: boolean
  undone: boolean
  undone_at: string | null
}

/** New-row payload — the DB defaults id/created_at/undone/undone_at. */
export type ActivityInsert = Pick<
  ActivityEntry,
  'action_type' | 'entity_type' | 'entity_id' | 'summary' | 'before' | 'after'
> & { reversible?: boolean }

// ── Alerts & push notifications — shared cross-client schema. Web ships
//    the data layer first (Phase A); iOS push, backend evaluation, and the Bell
//    inbox UI follow in later phases. See migration 20260725000000_alerts.sql. ──

/** notification_prefs row — one per (user, type). `type` is an open enum
 *  (budget_threshold, large_charge, low_balance, sync_failed, daily_spend,
 *  bill_due, periodic_digest); `config` holds per-type thresholds, e.g.
 *  {"pct":90}, {"amount":200}, {"cadence":"weekly"}. */
export interface NotificationPref {
  id: UUID
  type: string
  enabled: boolean
  config: Record<string, unknown>
  created_at?: string | null
  updated_at?: string | null
}

/** notifications row — a generated alert event shown in the inbox. `payload` carries
 *  deep-link context (category_id/account_id/transaction_id); `dedup_key` is the
 *  backend's once-per-user firing guard (null for ad-hoc alerts). Named AppNotification
 *  to avoid clashing with the DOM `Notification` global. */
export interface AppNotification {
  id: UUID
  type: string
  title: string
  body: string
  payload: Record<string, unknown>
  dedup_key: string | null
  read_at: string | null
  created_at: string // ISO timestamp
}

/** device_tokens row — an APNs push target registered by the iOS client. */
export interface DeviceToken {
  id: UUID
  token: string
  platform: string // 'ios'
  created_at?: string | null
  updated_at?: string | null
}

/** notifications row — a backend-generated alert (credit expiry, bonus
 *  deadline, annual fee, cancel-by). Shown in the bell inbox in TopAppBar;
 *  `data` carries deep-link context (card_id, credit_id, …). */
export type NotificationType = 'credit_expiry' | 'bonus_deadline' | 'annual_fee' | 'cancel_by'

export interface UserNotification {
  id: UUID
  type: NotificationType
  title: string
  body: string
  data: Record<string, unknown>
  is_read: boolean
  created_at: string // ISO timestamp
  dedup_key: string | null
}

/** profiles row — 1:1 with the auth user (id IS the auth user id). Holds the user's
 *  first/last name, display currency, theme choice, and per-type reminder
 *  preferences read by the notify.py scheduler. New columns read as undefined
 *  on rows fetched before the settings-preferences migration. */
export interface Profile {
  id: UUID
  first_name: string | null
  last_name: string | null
  /** Email digest opt-in for credit/bonus/fee reminders. Added by migration;
   *  undefined on rows read before the column exists. */
  notify_email_enabled?: boolean | null
  /** Display currency (ISO code), applied app-wide via lib/money. */
  currency?: string | null
  /** 'light' | 'dark' | 'system' — next-themes key persisted server-side. */
  theme?: string | null
  /** Card-credit reminders: on/off + lead-time days. */
  notify_credit_enabled?: boolean | null
  notify_credit_days?: number | null
  /** Signup-bonus deadline reminders: on/off + lead-time days. */
  notify_bonus_enabled?: boolean | null
  notify_bonus_days?: number | null
  /** Annual-fee / cancel-by reminders: on/off + lead-time days. */
  notify_fee_enabled?: boolean | null
  notify_fee_days?: number | null
  /** AI categorization master switch. Added by migration; undefined on rows
   *  read before the column exists (treated as enabled). */
  ai_enabled?: boolean | null
  /** AI classifier provider: 'jev' | 'gemini' | 'off'. */
  ai_provider?: string | null
  /** Confidence threshold (0..1) at/above which the AI verdict auto-applies. */
  ai_confidence_threshold?: number | null
  /** Spending-plan watched categories (Settings → Watched categories). Added by
   *  migration; undefined means "not yet set" — UI defaults to the seed list. */
  watched_categories?: string[] | null
  created_at?: string | null
  updated_at?: string | null
}

// ── computed helpers (mirror iOS model computed props) ─────────────────────

export function displayName(t: Transaction): string {
  return t.merchant_name || t.description || 'Unknown'
}

/** Lowercased/trimmed merchant key — MUST match iOS Transaction.merchantKey and the
 *  backend _merchant_key so learned memory lines up across clients. */
export function merchantKey(t: Transaction): string {
  return (t.merchant_name || t.description || '').trim().toLowerCase()
}

/** Asset vs liability by account type (mirrors iOS). */
export function isLiabilityType(type: string): boolean {
  return type === 'credit' || type === 'loan'
}

export type LiquidityBucket = 'liquid' | 'semiLiquid' | 'liability'

/** Liquidity bucket for the Balances split.
 *  - liquid: cash spendable now — `depository` (checking/savings).
 *  - semiLiquid: sellable-but-not-instant assets — `investment` (incl. retirement:
 *    401k/IRA/etc are investment-typed), `other`, and any unknown asset type.
 *  - liability: debt — `credit`, `loan`.
 *  Kept consistent with isLiabilityType: any non-liability type is an asset. */
export function liquidityBucket(type: string): LiquidityBucket {
  if (isLiabilityType(type)) return 'liability'
  if (type === 'depository') return 'liquid'
  return 'semiLiquid'
}

// ── Spending plan — Supabase row shapes (see data/spendingPlan.ts) ──────────

/** bills row — a recurring bill the user plans around. */
export interface Bill {
  id: UUID
  name: string
  amount: number // positive dollars
  due_day: number // 1–31
  category: string | null // free-text label, optional
  is_active: boolean
  created_at?: string | null
}

export type BillInsert = Pick<Bill, 'name' | 'amount' | 'due_day'> &
  Partial<Pick<Bill, 'category' | 'is_active'>>

/** savings_goals row — a named target with a monthly funding contribution. */
export interface SavingsGoal {
  id: UUID
  name: string
  target_amount: number // positive dollars
  monthly_contribution: number // positive dollars
  created_at?: string | null
}

export type SavingsGoalInsert = Pick<
  SavingsGoal,
  'name' | 'target_amount' | 'monthly_contribution'
>

// ── Churning tracker — Supabase row shapes (see data/churning.ts) ───────────

/** churn_cards row — a credit card being tracked for bonuses/credits/fees. */
export interface ChurnCard {
  id: UUID
  card_name: string
  issuer: string | null
  last4: string | null
  opened_date: string | null // yyyy-MM-dd
  annual_fee: number | null
  annual_fee_date: string | null // yyyy-MM-dd
  cancel_by_date: string | null // yyyy-MM-dd
  notes: string | null
  account_id: UUID | null // → accounts.id; links bonus spend tracking to real txns
  owner_name: string | null // full name of whose physical card this is (household shares cards)
  last5: string | null // last 5 digits of the card number; Plaid's mask gives the last 4, the 5th is a one-time manual entry
  created_at?: string | null
}

export type ChurnCardInsert = Pick<ChurnCard, 'card_name'> &
  Partial<
    Pick<
      ChurnCard,
      'issuer' | 'last4' | 'opened_date' | 'annual_fee' | 'annual_fee_date' | 'cancel_by_date' | 'notes' | 'account_id' | 'owner_name' | 'last5'
    >
  >

export type ChurnBonusStatus = 'in_progress' | 'completed' | 'failed'

/** churn_bonuses row — a signup/retention bonus with a spend requirement. */
export interface ChurnBonus {
  id: UUID
  card_id: UUID
  description: string
  spend_required: number // positive dollars
  spend_start_date: string | null // yyyy-MM-dd; defaults to the card's opened_date
  spend_by_date: string // yyyy-MM-dd, NOT NULL
  bonus_value: string | null // free text, e.g. "80k points"
  status: ChurnBonusStatus
  created_at?: string | null
  // joined card name (fetchAllChurnBonuses embeds churn_cards(card_name))
  churn_cards?: { card_name: string } | null
}

export type ChurnBonusInsert = Pick<
  ChurnBonus,
  'card_id' | 'description' | 'spend_required' | 'spend_by_date'
> &
  Partial<Pick<ChurnBonus, 'spend_start_date' | 'bonus_value' | 'status'>>

export type ChurnCreditFrequency = 'annual' | 'semiannual' | 'quarterly' | 'monthly' | 'quadrennial'

/** How a credit got marked used: the backend auto-detector, or the user by hand. */
export type CreditDetectionSource = 'auto' | 'manual'

/** churn_credits row — a recurring card credit (airline, dining, …).
 *  The auto-detection columns (auto_detect … period_start_date) come from the
 *  credit-detection migration; pre-migration rows read them as undefined, and the
 *  UI falls back to the DB defaults (auto_detect on, tolerance 0.01, remind 7d). */
export interface ChurnCredit {
  id: UUID
  card_id: UUID
  credit_name: string
  amount: number // positive dollars, full credit value
  frequency: ChurnCreditFrequency
  used_amount: number // positive dollars used so far this period
  reset_date: string | null // yyyy-MM-dd
  notes: string | null
  created_at?: string | null
  // ── auto-detection ──
  auto_detect: boolean
  detect_merchant_keywords: string[] // lowercased keyword list the detector matches
  detect_amount: number | null // expected statement-credit amount; null = any
  detect_tolerance: number // |txn − detect_amount| ≤ tolerance counts as a match
  used_at: string | null // ISO timestamp when the credit was marked used
  detected_transaction_id: UUID | null // latest txn auto-detection matched
  /** Every txn whose posting counted toward used_amount this cycle — the
   *  detector re-scans these each run so partial usage can accumulate
   *  without double-counting one posting for two credits. */
  detected_transaction_ids: UUID[]
  detection_source: CreditDetectionSource | null
  /** Txn ids the user dismissed — auto-detect must never re-mark these. */
  detection_dismissed_transaction_ids: UUID[]
  remind_days_before: number // "credits needing attention" + notification window
  period_start_date: string | null // yyyy-MM-dd; start of the current credit period
  /** Hidden by the user (Rewards) — excluded from all lists/totals/counts. */
  is_hidden: boolean
  /** Short display label like "Amex", "United", "Hyatt"; falls back to card/credit name. */
  program_label: string | null
  // joined card name (fetchAllChurnCredits embeds churn_cards(card_name))
  churn_cards?: { card_name: string } | null
}

export type ChurnCreditInsert = Pick<ChurnCredit, 'card_id' | 'credit_name' | 'amount'> &
  Partial<Pick<ChurnCredit, 'frequency' | 'used_amount' | 'reset_date' | 'notes'>> &
  Partial<
    Pick<
      ChurnCredit,
      | 'auto_detect'
      | 'detect_merchant_keywords'
      | 'detect_amount'
      | 'detect_tolerance'
      | 'remind_days_before'
      | 'period_start_date'
      | 'used_at'
      | 'detected_transaction_id'
      | 'detection_source'
      | 'detection_dismissed_transaction_ids'
      | 'is_hidden'
      | 'program_label'
    >
  >

// ── Discretionary (Daniel-vs-Sara game/bet balances — never part of household
//  totals or the spending plan; stored in their own tables) ─────────────────

export type DiscretionaryPerson = 'daniel' | 'sara'

export type DiscretionaryEntryType = 'game' | 'purchase' | 'challenge' | 'bet' | 'adjustment'

/** discretionary_game_types row. */
export interface DiscretionaryGameType {
  id: UUID
  name: string
  created_at?: string | null
}

/** discretionary_ledger row. Signed payouts: one row holds both sides
 *  (e.g. Daniel −$10 / Sara +$10). */
export interface DiscretionaryLedgerEntry {
  id: UUID
  occurred_on: string // yyyy-MM-dd
  entry_type: DiscretionaryEntryType
  game_type_id: UUID | null
  winner: 'daniel' | 'sara' | 'tie' | null
  payout: number | null
  daniel_amount: number // signed dollars
  sara_amount: number // signed dollars
  challenge_id: UUID | null
  note: string | null
  created_at?: string | null
}

export type DiscretionaryLedgerInsert = Pick<
  DiscretionaryLedgerEntry,
  'occurred_on' | 'entry_type' | 'daniel_amount' | 'sara_amount'
> &
  Partial<
    Pick<
      DiscretionaryLedgerEntry,
      'game_type_id' | 'winner' | 'payout' | 'challenge_id' | 'note'
    >
  >

export type ChallengeFrequency = 'daily' | 'weekly'
export type ChallengeStatus = 'active' | 'completed' | 'failed' | 'overridden'

/** challenges row. */
export interface Challenge {
  id: UUID
  person: DiscretionaryPerson
  title: string
  start_date: string // yyyy-MM-dd
  end_date: string // yyyy-MM-dd
  frequency: ChallengeFrequency
  times_per_week: number | null
  reward: number // positive dollars paid to `person` on completion
  grace_days: number
  status: ChallengeStatus
  created_at?: string | null
}

export type ChallengeInsert = Pick<
  Challenge,
  'person' | 'title' | 'start_date' | 'end_date' | 'frequency' | 'reward'
> &
  Partial<Pick<Challenge, 'times_per_week' | 'grace_days' | 'status'>>

/** challenge_checkins row — one per challenge per day. */
export interface ChallengeCheckin {
  id: UUID
  challenge_id: UUID
  checkin_date: string // yyyy-MM-dd
  created_at?: string | null
}

/** reward_points row — manual points balances, one per program/holder. */
export interface RewardPoints {
  id: UUID
  program: string
  holder: string
  balance: number // points
  last_updated: string | null
  created_at?: string | null
}

export type RewardPointsInsert = Pick<RewardPoints, 'program' | 'holder' | 'balance'> &
  Partial<Pick<RewardPoints, 'last_updated'>>

// ── Budgets / Forecast / Retirement / Txn tags (self-hosted budget app) ─────

/** Need vs want tag on a transaction (nullable until the backend auto-fills). */
export type NeedWant = 'need' | 'want'
/** Fixed vs variable spend pattern on a transaction. */
export type SpendPattern = 'fixed' | 'variable'

/** budgets row — one monthly per-category budget target. `month` is the
 *  first-of-month date; `category` is the category name (text). */
export interface Budget {
  id: UUID
  user_id?: UUID
  month: string // yyyy-MM-dd, first of month
  category: string
  target: number // positive dollars
  created_at?: string | null
}

export type BudgetInsert = Pick<Budget, 'month' | 'category' | 'target'>

export type ForecastAdjustmentKind = 'recurring' | 'one_time'
export type ForecastAdjustmentDirection = 'income' | 'spending'

/** forecast_adjustments row — a named tweak layered onto the forecast baseline.
 *  Recurring adjustments apply to every month in [start_month, end_month]
 *  (open ends allowed); one-time adjustments apply to `month` only. All dates
 *  are first-of-month yyyy-MM-dd strings. */
export interface ForecastAdjustment {
  id: UUID
  user_id?: UUID
  kind: ForecastAdjustmentKind
  direction: ForecastAdjustmentDirection
  name: string
  amount: number // positive dollars
  start_month: string | null
  end_month: string | null
  month: string | null
  created_at?: string | null
}

export type ForecastAdjustmentInsert = Pick<
  ForecastAdjustment,
  'kind' | 'direction' | 'name' | 'amount'
> &
  Partial<Pick<ForecastAdjustment, 'start_month' | 'end_month' | 'month'>>

/** Tax treatment of a retirement account bucket. */
export type RetirementTaxTreatment = 'taxable' | 'traditional' | 'roth'

/** One account bucket in the retirement model. */
export interface RetirementAccountInput {
  /** Client-generated key (uuid). */
  id: string
  name: string
  balance: number // today's dollars
  annualContribution: number // per year, today's dollars (inflated yearly)
  taxTreatment: RetirementTaxTreatment
  /** Optional per-account return override %, null = use the global return. */
  returnOverridePct: number | null
}

/** A one-time addition to an account in a given calendar year (that year's dollars). */
export interface RetirementOneTime {
  id: string
  amount: number
  year: number // calendar year
  accountId: string
}

/** The full retirement model input — stored as JSON in retirement_scenarios. */
export interface RetirementInputs {
  currentAge: number
  retirementAge: number
  planThroughAge: number
  preRetirementReturnPct: number
  postRetirementReturnPct: number
  inflationPct: number
  /** Annual, today's dollars (inflated yearly in the projection). */
  preRetirementIncome: number
  preRetirementSpending: number
  postRetirementSpending: number
  /** Expected tax rate on Traditional withdrawals in retirement, %. */
  retirementTaxRatePct: number
  accounts: RetirementAccountInput[]
  oneTimes: RetirementOneTime[]
}

/** retirement_scenarios row — a saved named retirement model. */
export interface RetirementScenario {
  id: UUID
  user_id?: UUID
  name: string
  inputs: RetirementInputs
  created_at?: string | null
  updated_at?: string | null
}

export type RetirementScenarioInsert = Pick<RetirementScenario, 'name' | 'inputs'>

/** merchant_txn_tags row — learned need/want + fixed/variable tags per merchant. */
export interface MerchantTxnTag {
  id: UUID
  user_id?: UUID
  merchant_key: string
  need_want: NeedWant | null
  spend_pattern: SpendPattern | null
  updated_at?: string | null
}

export type MerchantTxnTagInsert = Pick<
  MerchantTxnTag,
  'merchant_key' | 'need_want' | 'spend_pattern'
>
