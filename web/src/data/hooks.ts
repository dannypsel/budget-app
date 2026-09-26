// React Query hooks over our Supabase data modules. Separate key namespace ('sb') from
// Keep's original int-id queryKeys.

import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { triggerSync, describeSyncSummary, backfillAll, type BackfillAllResult } from './sync'
import * as txns from './transactions'
import * as accts from './accounts'
import * as cats from './categories'
import * as sep from './separateAccounts'
import * as transfersApi from './transfers'
import * as recurringApi from './recurring'
import * as categoryGroupsApi from './categoryGroups'
import * as profileApi from './profile'
import * as spendingPlanApi from './spendingPlan'
import * as churningApi from './churning'
import * as notificationsApi from './notifications'
import { fetchPlaidItems, deleteItem as deletePlaidItem } from './plaidItems'
import { toISODate } from '@/lib/dates'
import type {
  BillInsert,
  Category,
  CategoryGroup,
  ChurnBonusInsert,
  ChurnCardInsert,
  ChurnCreditInsert,
  PlaidItem,
  SavingsGoalInsert,
  Transaction,
  UUID,
} from '@/types/domain'

export const sbKeys = {
  categories: ['sb', 'categories'] as const,
  rules: ['sb', 'rules'] as const,
  merchantMemory: ['sb', 'merchantMemory'] as const,
  transactionsMonth: (iso: string) => ['sb', 'transactions', 'month', iso] as const,
  transactionsMonthAll: (iso: string) => ['sb', 'transactions', 'month-all', iso] as const,
  transactionsRange: (start: string, end: string) =>
    ['sb', 'transactions', 'range', start, end] as const,
  spendByCategory: (iso: string) => ['sb', 'transactions', 'spendByCategory', iso] as const,
  transferGroups: (iso: string) => ['sb', 'transactions', 'transferGroups', iso] as const,
  transferGroupLegs: (groupId: UUID) => ['sb', 'transactions', 'transferGroupLegs', groupId] as const,
  transferSuggestions: ['sb', 'transactions', 'transferSuggestions'] as const,
  recent: (days: number) => ['sb', 'transactions', 'recent', days] as const,
  transactionSearch: (q: string) => ['sb', 'transactions', 'search', q] as const,
  uncategorized: (monthKey: string) => ['sb', 'transactions', 'uncategorized', monthKey] as const,
  transactionsByAccount: (accountId: UUID) => ['sb', 'transactions', 'account', accountId] as const,
  accounts: ['sb', 'accounts'] as const,
  // Distinct key from `accounts`: the two hooks share the same base but different
  // query fns (with vs without latest balances). Under one key, whichever mounts
  // first wins the cache, so navigating from a page that used the balance-less
  // `useAccounts` left the Balances page showing accounts with no balances until a
  // hard refresh. Nested under `accounts` so invalidating that prefix still hits both.
  accountsWithBalance: ['sb', 'accounts', 'withBalance'] as const,
  budgetLimits: ['sb', 'budgetLimits'] as const,
  separateAccounts: ['sb', 'separateAccounts'] as const,
  // Nested under separateAccounts so invalidating the list prefix also refreshes
  // a detail page's ledger + contributions.
  separateAccountValues: (id: UUID) => ['sb', 'separateAccounts', id, 'values'] as const,
  separateAccountContributions: (id: UUID) =>
    ['sb', 'separateAccounts', id, 'contributions'] as const,
  plaidItems: ['sb', 'plaidItems'] as const,
  recurring: ['sb', 'recurring'] as const,
  categoryGroups: ['sb', 'categoryGroups'] as const,
  profile: ['sb', 'profile'] as const,
  plannedIncome: ['sb', 'spendingPlan', 'plannedIncome'] as const,
  bills: ['sb', 'spendingPlan', 'bills'] as const,
  savingsGoals: ['sb', 'spendingPlan', 'savingsGoals'] as const,
  churnCards: ['sb', 'churning', 'cards'] as const,
  churnCard: (id: UUID) => ['sb', 'churning', 'cards', id] as const,
  churnBonuses: (cardId: UUID) => ['sb', 'churning', 'bonuses', cardId] as const,
  allChurnBonuses: ['sb', 'churning', 'bonuses', 'all'] as const,
  churnCredits: (cardId: UUID) => ['sb', 'churning', 'credits', cardId] as const,
  allChurnCredits: ['sb', 'churning', 'credits', 'all'] as const,
  notifications: ['sb', 'notifications'] as const,
}

export function useCategories() {
  return useQuery({ queryKey: sbKeys.categories, queryFn: () => cats.fetchCategories() })
}
export function useRules() {
  return useQuery({ queryKey: sbKeys.rules, queryFn: cats.fetchRules })
}

/** Add a keyword→category rule. New rules change auto-match suggestions, so refresh the
 *  rules cache and the activity feed (addRule logs an entry). */
export function useAddRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (rule: cats.NewRule) => cats.addRule(rule),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.rules })
    },
  })
}

/** Delete a keyword rule; refresh the rules cache. */
export function useDeleteRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => cats.deleteRule(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.rules })
    },
  })
}

/** Create/rename/recolor/re-icon a category. Name/color/icon render everywhere via the
 *  categories cache, so that one key covers display changes. */
export function useUpsertCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (cat: Partial<Category> & { name: string; color: string; icon: string }) =>
      cats.upsertCategory(cat),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.categories }),
  })
}

/** Persist a new category display order (drag-to-reorder). Writes sort_order per row,
 *  then refreshes the categories cache so every picker/list reflects the new order. */
export function useReorderCategories() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ordered: Category[]) => cats.reorderCategories(ordered),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.categories }),
  })
}

/** Delete a category. Cascades its budget/split rows in the DB; transactions fall
 *  back to uncategorized (category_id set null) — refresh everything that shows them. */
export function useDeleteCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => cats.deleteCategory(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.categories })
      qc.invalidateQueries({ queryKey: sbKeys.budgetLimits })
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
    },
  })
}

// ── Category groups ──────────────────────────────────────────────────────────

export function useCategoryGroups() {
  return useQuery({
    queryKey: sbKeys.categoryGroups,
    queryFn: categoryGroupsApi.fetchCategoryGroups,
  })
}

/** Create or rename a category group. */
export function useUpsertCategoryGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (group: Partial<CategoryGroup> & { name: string }) =>
      categoryGroupsApi.upsertCategoryGroup(group),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.categoryGroups }),
  })
}

/** Delete a group; the DB ON DELETE SET NULL ungroups its categories automatically. */
export function useDeleteCategoryGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => categoryGroupsApi.deleteCategoryGroup(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.categoryGroups })
      // categories.group_id may have been nulled by the cascade
      qc.invalidateQueries({ queryKey: sbKeys.categories })
    },
  })
}

/** Persist a new display order for groups (drag-to-reorder). */
export function useReorderCategoryGroups() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ordered: CategoryGroup[]) =>
      categoryGroupsApi.reorderCategoryGroups(ordered),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.categoryGroups }),
  })
}

/** Assign a category to a group, or clear its group when groupId is null. */
export function useSetCategoryGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ categoryId, groupId }: { categoryId: UUID; groupId: UUID | null }) =>
      categoryGroupsApi.setCategoryGroup(categoryId, groupId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.categories })
      qc.invalidateQueries({ queryKey: sbKeys.categoryGroups })
    },
  })
}

export function useMerchantMemory() {
  return useQuery({ queryKey: sbKeys.merchantMemory, queryFn: txns.fetchMerchantMemory })
}
/** Cache-key fragment for a month (unpadded, e.g. "2026-7") — one spelling so every
 *  month-scoped key matches and invalidates together. */
function monthKey(month: Date): string {
  return `${month.getFullYear()}-${month.getMonth() + 1}`
}

export function useTransactionsMonth(month: Date) {
  return useQuery({
    queryKey: sbKeys.transactionsMonth(monthKey(month)),
    queryFn: () => txns.fetchTransactions(month),
  })
}
/** Splits-aware spend per category for a month, from the `category_spend` view — the
 *  cross-client source of truth. Use this instead of fetching every month txn just to
 *  re-sum client-side (the old `domain.categorySpend` path). Returns rows sorted by
 *  spend desc. */
export function useSpendByCategory(month: Date) {
  return useQuery({
    queryKey: sbKeys.spendByCategory(monthKey(month)),
    queryFn: () => txns.fetchSpendByCategory(month),
  })
}

/** Month transactions including excluded/transfer rows (Transactions page, so transfers
 *  stay visible + unlinkable). Separate cache key from useTransactionsMonth. */
export function useTransactionsMonthAll(month: Date) {
  return useQuery({
    queryKey: sbKeys.transactionsMonthAll(monthKey(month)),
    queryFn: () => txns.fetchTransactions(month, { includeExcluded: true }),
  })
}
/** Transactions in an arbitrary [startISO, endISO] range (Reports page). Fetches
 *  excluded/transfer rows too — the page applies its exclude toggles client-side
 *  so toggling is instant. Nested under ['sb','transactions'] so mutations refresh it. */
export function useTransactionsRange(startISO: string, endISO: string) {
  return useQuery({
    queryKey: sbKeys.transactionsRange(startISO, endISO),
    queryFn: () => txns.fetchTransactionsRange(startISO, endISO, { includeExcluded: true }),
    enabled: startISO !== '' && endISO !== '' && startISO <= endISO,
  })
}
export function useRecent(days: number) {
  return useQuery({ queryKey: sbKeys.recent(days), queryFn: () => txns.fetchRecent(days) })
}
/** Server-side search (all months). Pass the already-debounced query; disabled
 *  while blank. Nested under ['sb','transactions'] so mutations invalidate it. */
export function useTransactionSearch(q: string) {
  return useQuery({
    queryKey: sbKeys.transactionSearch(q),
    queryFn: () => txns.searchTransactions(q),
    enabled: q.trim().length > 0,
    // keep the previous results on screen while the next query loads
    placeholderData: (prev: Transaction[] | undefined) => prev,
    // every distinct query string is its own cache key and is never re-typed
    // exactly — collect them quickly instead of the default 5 minutes
    gcTime: 30_000,
  })
}
/** The "To Categorize" queue, scoped to `month` (banner + review flow). */
export function useUncategorized(month: Date) {
  return useQuery({
    queryKey: sbKeys.uncategorized(`${month.getFullYear()}-${month.getMonth()}`),
    queryFn: () => txns.fetchUncategorized(month),
  })
}
/** All transactions for a single account (for AccountDetailPage). */
export function useTransactionsByAccount(accountId: UUID) {
  return useQuery({
    queryKey: sbKeys.transactionsByAccount(accountId),
    queryFn: () => txns.fetchTransactionsByAccount(accountId),
    enabled: Boolean(accountId),
  })
}

export function useAccountsWithBalance() {
  return useQuery({
    queryKey: sbKeys.accountsWithBalance,
    queryFn: accts.fetchAccountsWithLatestBalance,
  })
}
export function useAccounts() {
  return useQuery({ queryKey: sbKeys.accounts, queryFn: () => accts.fetchAccounts() })
}

/** Soft-delete a single Plaid account (sets is_active = false). The institution
 *  link is preserved so other accounts under the same institution keep syncing. */
export function useHideAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (accountId: string) => accts.hideAccount(accountId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.accounts })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not delete account'),
  })
}

/** Most-recent reported balance for one account — for the account detail header. */
export function useLatestBalance(accountId: UUID) {
  return useQuery({
    queryKey: ['sb', 'accounts', accountId, 'latestBalance'] as const,
    queryFn: () => accts.fetchLatestBalance(accountId),
    enabled: Boolean(accountId),
  })
}

/** Change an account's type. Refreshes the accounts list. */
export function usePatchAccountType() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ accountId, type }: { accountId: string; type: string }) =>
      accts.patchAccountType(accountId, type),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.accounts })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not update account type'),
  })
}

/** Hard-delete an account and cascade its transactions. Unlinks transfer legs on other
 *  accounts first. Refreshes accounts + transactions caches. */
export function useDeleteAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (accountId: string) => accts.deleteAccount(accountId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.accounts })
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not delete account'),
  })
}

export function useSeparateAccounts() {
  return useQuery({ queryKey: sbKeys.separateAccounts, queryFn: sep.fetchSeparateAccounts })
}

// ── Manual "separate" accounts — value ledger + recurring contributions ───────
// A separate account's balance = SUM(values), so any value/contribution mutation
// changes its balance. Nesting the per-account keys under sbKeys.separateAccounts
// means invalidating that prefix refreshes the list card, the detail balance, and
// the ledger at once.
function invalidateSeparateAccounts(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: sbKeys.separateAccounts })
}

export function useSeparateAccountValues(accountId: UUID) {
  return useQuery({
    queryKey: sbKeys.separateAccountValues(accountId),
    queryFn: () => sep.fetchValues(accountId),
  })
}

export function useSeparateAccountContributions(accountId: UUID) {
  return useQuery({
    queryKey: sbKeys.separateAccountContributions(accountId),
    queryFn: () => sep.fetchContributions(accountId),
  })
}

/** Create a manual account, optionally seeding a starting balance and a recurring
 *  contribution in one action (mirrors iOS AddSeparateAccountSheet). */
export function useCreateSeparateAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      name: string
      type: string
      startingBalance?: number | null
      recurring?: { delta: number; frequencyInDays: number; anchorISO: string } | null
    }) => {
      const account = await sep.createSeparateAccount({
        name: input.name,
        type: input.type,
        currency: 'USD',
      })
      if (input.startingBalance != null) {
        await sep.addValue({
          separate_account_id: account.id,
          date: toISODate(new Date()),
          amount: input.startingBalance,
          note: 'Starting balance',
        })
      }
      if (input.recurring) {
        await sep.addContribution({
          separate_account_id: account.id,
          delta_balance: input.recurring.delta,
          frequency_in_days: input.recurring.frequencyInDays,
          anchor_date: input.recurring.anchorISO,
        })
      }
      return account
    },
    onSuccess: () => invalidateSeparateAccounts(qc),
  })
}

export function useDeleteSeparateAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => sep.deleteSeparateAccount(id),
    onSuccess: () => invalidateSeparateAccounts(qc),
  })
}

export function useAddSeparateAccountValue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: {
      separate_account_id: UUID
      date: string
      amount: number
      note: string | null
    }) => sep.addValue(payload),
    onSuccess: () => invalidateSeparateAccounts(qc),
  })
}

export function useAddContribution() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: {
      separate_account_id: UUID
      delta_balance: number
      frequency_in_days: number
      anchor_date: string
    }) => sep.addContribution(payload),
    onSuccess: () => invalidateSeparateAccounts(qc),
  })
}

export function useDeleteContribution() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => sep.deleteContribution(id),
    onSuccess: () => invalidateSeparateAccounts(qc),
  })
}
export function usePlaidItems() {
  return useQuery({
    queryKey: sbKeys.plaidItems,
    queryFn: fetchPlaidItems,
    // While any bank is mid-sync, poll so is_syncing (and last_synced_at) update
    // live; stop once every item settles. Drives the in-progress indicator.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((i) => i.is_syncing) ? 3_000 : false,
  })
}

/** True while any linked bank is mid-sync (per-item lock). Powers the "Syncing…"
 *  indicator on Balances + Settings. Reuses the usePlaidItems cache. */
export function useSyncInProgress(): boolean {
  const { data } = usePlaidItems()
  return (data ?? []).some((i) => i.is_syncing)
}

/** Unlink a Plaid bank. On success, clears the plaidItems cache and also
 *  invalidates accounts + transactions since those rows were deleted server-side. */
export function useDeletePlaidItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (itemId: string) => deletePlaidItem(itemId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.plaidItems })
      qc.invalidateQueries({ queryKey: sbKeys.accounts })
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not unlink bank'),
  })
}

// ── Plaid sync trigger + post-sync refresh ───────────────────────────────────
// /sync/trigger runs the Plaid pull inline (Lambda) and the response carries a
// sync summary, so the cache is invalidated immediately on success. The delayed
// invalidations are kept as a safety net: an older fire-and-forget backend may
// still be writing when the response lands, and a slow write then still shows
// up. Shared by the Sync buttons on Accounts and Settings.
const SYNC_REFRESH_DELAYS_MS = [3_000, 8_000]

/** Everything a Plaid sync can change. */
function invalidateAfterSync(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: sbKeys.accounts })
  qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
  qc.invalidateQueries({ queryKey: sbKeys.plaidItems })
}

export function useTriggerSync() {
  const qc = useQueryClient()
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  // Don't let a queued refetch fire after the button's page unmounts.
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  return useMutation({
    mutationFn: triggerSync,
    // The mutation resolves when the sync is complete, so invalidate right
    // away and surface the returned summary; the delayed invalidations above
    // stay as a safety net for a slow/older backend.
    onSuccess: (summary) => {
      toast.success(describeSyncSummary(summary))
      invalidateAfterSync(qc)
      const refresh = () => invalidateAfterSync(qc)
      timers.current = SYNC_REFRESH_DELAYS_MS.map((ms) => setTimeout(refresh, ms))
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Sync failed'),
  })
}

// ── Auto-sync on sign-in ──────────────────────────────────────────────────────
// Syncs are manual (the user taps Sync) — there is no background scheduler. If
// a user opens the app and some linked bank hasn't synced in over an hour,
// kick the same incremental sync the Sync button runs, once per sign-in.
// Silent on failure — the button remains the explicit path.

export const AUTO_SYNC_STALE_MS = 60 * 60 * 1000

/** True when some linked bank is idle and hasn't synced in the last hour (or ever). */
export function isSyncStale(items: PlaidItem[], now: number = Date.now()): boolean {
  return items.some(
    (i) =>
      !i.is_syncing &&
      (i.last_synced_at == null || now - Date.parse(i.last_synced_at) > AUTO_SYNC_STALE_MS),
  )
}

export function useAutoSyncOnLogin(userId: string | null) {
  const qc = useQueryClient()
  const { data: items } = usePlaidItems()
  const decidedFor = useRef<string | null>(null)
  const wasSyncing = useRef(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  useEffect(() => {
    if (!userId || !items) return
    // Decide once per signed-in user, the first time the bank list is known.
    if (decidedFor.current !== userId) {
      decidedFor.current = userId
      if (isSyncStale(items)) {
        triggerSync()
          .then(() => {
            // The sync already ran inline; invalidate right away and keep the
            // delayed passes as a safety net for a slow/older backend.
            invalidateAfterSync(qc)
            timers.current = SYNC_REFRESH_DELAYS_MS.map((ms) =>
              setTimeout(() => invalidateAfterSync(qc), ms),
            )
          })
          .catch((e: unknown) => console.warn('auto-sync on sign-in failed', e))
      }
    }
    // usePlaidItems polls while any bank is mid-sync; when the last one settles,
    // pull the fresh rows in. Covers slow syncs the fixed delays above miss, and
    // syncs started from another tab or device while the app was open.
    const syncing = items.some((i) => i.is_syncing)
    if (wasSyncing.current && !syncing) invalidateAfterSync(qc)
    wasSyncing.current = syncing
  }, [userId, items, qc])
}

/** Full sync: reset every bank's cursor and re-pull the full 730-day window.
 *  Rate-limited server-side — a `cooldown` result surfaces as an info toast with
 *  the next-available time instead of an error. Shared refresh logic with
 *  useTriggerSync (invalidate everything a Plaid sync can change). */
export function useBackfillAll() {
  const qc = useQueryClient()
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  return useMutation({
    mutationFn: backfillAll,
    onSuccess: (res: BackfillAllResult) => {
      if (res.status === 'cooldown') {
        const when = res.next_at ? new Date(res.next_at).toLocaleString() : 'soon'
        toast.info(`Full sync ran recently. Next one available ${when}.`)
        return
      }
      toast.success('Full sync started — re-importing history may take a few minutes.')
      // Flip is_syncing right away so the in-progress poll (usePlaidItems) starts.
      qc.invalidateQueries({ queryKey: sbKeys.plaidItems })
      const refresh = () => {
        qc.invalidateQueries({ queryKey: sbKeys.accounts })
        qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
        qc.invalidateQueries({ queryKey: sbKeys.plaidItems })
      }
      timers.current = SYNC_REFRESH_DELAYS_MS.map((ms) => setTimeout(refresh, ms))
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Full sync failed'),
  })
}

/** Link two legs into a transfer; refresh txn lists (both legs drop from totals). */
export function useLinkTransfer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ a, b }: { a: Transaction; b: Transaction }) =>
      transfersApi.linkTransfer(a, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] }),
  })
}

/** Unlink a transfer group; refresh txn lists (legs re-enter totals). */
export function useUnlinkTransfer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (groupId: UUID) => transfersApi.unlinkTransfer(groupId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] }),
  })
}

/** A month's transfer groups ({groupId → legs}) for the Transfers tab. */
export function useTransferGroups(month: Date) {
  return useQuery({
    queryKey: sbKeys.transferGroups(monthKey(month)),
    queryFn: () => transfersApi.fetchTransferGroups(month),
  })
}

/** All legs of a single transfer group — used in the transaction detail modal to show
 *  the from→to route when only one leg is in scope. Pass null to skip. */
export function useTransferGroupLegs(groupId: UUID | null) {
  return useQuery({
    queryKey: sbKeys.transferGroupLegs(groupId ?? ('none' as UUID)),
    queryFn: () => transfersApi.fetchTransferGroupLegs(groupId!),
    enabled: groupId != null,
  })
}

/** Likely-transfer pairs the auto-detector declined (no Plaid signal / ambiguous). */
export function useTransferSuggestions() {
  return useQuery({
    queryKey: sbKeys.transferSuggestions,
    queryFn: () => transfersApi.findTransferSuggestions(),
  })
}

/** "Not a transfer" on a suggested pair: opts both rows out of future matching. */
export function useDismissSuggestion() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ a, b }: { a: Transaction; b: Transaction }) =>
      transfersApi.dismissSuggestion(a, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] }),
  })
}

/** Hide/unhide a transaction; refresh txn lists + totals (row enters/leaves totals). */
export function useSetHidden() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ txn, hidden }: { txn: Transaction; hidden: boolean }) =>
      txns.setHidden(txn, hidden),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] }),
  })
}

/** Include/exclude a transaction from spending-plan + spend totals via
 *  exclude_from_totals; refresh txn lists + totals. */
export function useSetExcludeFromTotals() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ transactionId, exclude }: { transactionId: UUID; exclude: boolean }) =>
      txns.setExcludeFromTotals(transactionId, exclude),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] }),
  })
}

/** Detected recurring series (client-side) with the user's overrides applied. */
export function useRecurringSeries() {
  return useQuery({ queryKey: sbKeys.recurring, queryFn: recurringApi.fetchRecurringSeries })
}

/** Set/clear a series decision (confirm/ignore/remove, or null to reset to suggested). */
export function useSetRecurringStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      merchantKey,
      status,
    }: {
      merchantKey: string
      status: recurringApi.RecurringStatus | null
    }) =>
      status && status !== 'suggested'
        ? recurringApi.setRecurringStatus(merchantKey, status)
        : recurringApi.clearRecurringStatus(merchantKey),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.recurring }),
  })
}

/** Apply a category to every occurrence of a series; refresh recurring + txn views. */
export function useCategorizeRecurringSeries() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ occurrenceIds, categoryId }: { occurrenceIds: UUID[]; categoryId: UUID }) =>
      recurringApi.categorizeRecurringSeries(occurrenceIds, categoryId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.recurring })
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
    },
  })
}

/** Import parsed CSV rows into an account; refresh txn lists + accounts. */
export function useImportTransactions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ accountId, rows }: { accountId: UUID; rows: txns.ImportRow[] }) =>
      txns.importTransactions(accountId, rows),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
      qc.invalidateQueries({ queryKey: sbKeys.accounts })
    },
  })
}

/** Invalidate everything that changes when a transaction's category changes. */
export function useSetCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ txn, categoryId }: { txn: Transaction; categoryId: UUID | null }) =>
      txns.setCategory(txn, categoryId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
      qc.invalidateQueries({ queryKey: sbKeys.merchantMemory })
    },
  })
}

/** Mark/unmark a credit as a reimbursement (contra-expense). Changes both the flag and
 *  the offset category, which ripple into category spend — so refresh transactions. */
export function useSetReimbursement() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      transactionId,
      isReimbursement,
      categoryId,
    }: {
      transactionId: UUID
      isReimbursement: boolean
      categoryId: UUID | null
    }) => txns.setReimbursement(transactionId, isReimbursement, categoryId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
      qc.invalidateQueries({ queryKey: sbKeys.budgetLimits })
    },
  })
}

/** Accept the "categorize similar?" bulk prompt — apply the category to the merchant's
 *  other uncategorized txns (no re-learning; useSetCategory already updated memory). */
export function useBulkCategorizeMerchant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ merchantKey, categoryId }: { merchantKey: string; categoryId: UUID }) =>
      txns.bulkCategorizeSameMerchant(merchantKey, categoryId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] }),
  })
}

/** One-tap "Auto-categorize uncategorized": apply merchant memory + keyword rules to every
 *  uncategorized txn. Resolves to the count applied. */
export function useAutoCategorizeUncategorized() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => txns.autoCategorizeUncategorized(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
      qc.invalidateQueries({ queryKey: sbKeys.budgetLimits })
    },
  })
}

// ── Profile (first/last name) ────────────────────────────────────────────────

/** The signed-in user's profile row (first/last name), or null if not seeded yet. */
export function useMyProfile() {
  return useQuery({ queryKey: sbKeys.profile, queryFn: profileApi.fetchMyProfile })
}

/** Update the signed-in user's profile (name, currency, theme, reminder prefs,
 *  and/or email-notification opt-in); refresh the profile cache. */
export function useUpdateMyProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: profileApi.ProfilePatch) => profileApi.updateMyProfile(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.profile }),
  })
}

// ── Notifications (bell inbox) ───────────────────────────────────────────────

function invalidateNotifications(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: sbKeys.notifications })
}

/** All of the caller's notifications, newest first. */
export function useNotifications() {
  return useQuery({ queryKey: sbKeys.notifications, queryFn: notificationsApi.fetchNotifications })
}

/** Unread count for the bell badge, derived from the notifications list (one query). */
export function useUnreadNotificationCount(): number {
  const { data = [] } = useNotifications()
  return data.reduce((n, x) => n + (x.is_read ? 0 : 1), 0)
}

/** Mark one notification read. */
export function useMarkNotificationRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => notificationsApi.markNotificationRead(id),
    onSuccess: () => invalidateNotifications(qc),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not mark read'),
  })
}

/** Mark every unread notification read. */
export function useMarkAllNotificationsRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => notificationsApi.markAllNotificationsRead(),
    onSuccess: () => invalidateNotifications(qc),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not mark all read'),
  })
}

// ── Account deletion ─────────────────────────────────────────────────────────

/** Permanently delete the signed-in user's entire account and all their data.
 *  Calls DELETE /account on the backend (which uses auth.admin.delete_user),
 *  cascading through every user-owned table via on-delete-cascade FK constraints.
 *  This is irreversible — the caller must confirm in the UI before invoking. */
export function useDeleteMyAccount() {
  return useMutation({
    mutationFn: accts.deleteMyAccount,
  })
}

// ── Spending plan ────────────────────────────────────────────────────────────

/** The caller's planned monthly income (null = never set). */
export function usePlannedIncome() {
  return useQuery({ queryKey: sbKeys.plannedIncome, queryFn: spendingPlanApi.fetchPlannedIncome })
}

/** Save the planned monthly income; refresh the spending-plan cache. */
export function useSavePlannedIncome() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (income: number) => spendingPlanApi.savePlannedIncome(income),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.plannedIncome }),
  })
}

/** All of the caller's bills, soonest due-day first. */
export function useBills() {
  return useQuery({ queryKey: sbKeys.bills, queryFn: spendingPlanApi.fetchBills })
}

function invalidateSpendingPlan(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: sbKeys.plannedIncome })
  qc.invalidateQueries({ queryKey: sbKeys.bills })
  qc.invalidateQueries({ queryKey: sbKeys.savingsGoals })
}

export function useCreateBill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (bill: BillInsert) => spendingPlanApi.createBill(bill),
    onSuccess: () => invalidateSpendingPlan(qc),
  })
}

export function useUpdateBill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: UUID; patch: Partial<BillInsert> }) =>
      spendingPlanApi.updateBill(id, patch),
    onSuccess: () => invalidateSpendingPlan(qc),
  })
}

export function useSetBillActive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, isActive }: { id: UUID; isActive: boolean }) =>
      spendingPlanApi.setBillActive(id, isActive),
    onSuccess: () => invalidateSpendingPlan(qc),
  })
}

export function useDeleteBill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => spendingPlanApi.deleteBill(id),
    onSuccess: () => invalidateSpendingPlan(qc),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not delete bill'),
  })
}

/** All of the caller's savings goals, oldest first. */
export function useSavingsGoals() {
  return useQuery({ queryKey: sbKeys.savingsGoals, queryFn: spendingPlanApi.fetchSavingsGoals })
}

export function useCreateSavingsGoal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (goal: SavingsGoalInsert) => spendingPlanApi.createSavingsGoal(goal),
    onSuccess: () => invalidateSpendingPlan(qc),
  })
}

export function useUpdateSavingsGoal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: UUID; patch: Partial<SavingsGoalInsert> }) =>
      spendingPlanApi.updateSavingsGoal(id, patch),
    onSuccess: () => invalidateSpendingPlan(qc),
  })
}

export function useDeleteSavingsGoal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => spendingPlanApi.deleteSavingsGoal(id),
    onSuccess: () => invalidateSpendingPlan(qc),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not delete goal'),
  })
}

// ── Churning tracker ─────────────────────────────────────────────────────────

function invalidateChurning(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['sb', 'churning'] })
}

/** All of the caller's tracked cards, newest first. */
export function useChurnCards() {
  return useQuery({ queryKey: sbKeys.churnCards, queryFn: churningApi.fetchChurnCards })
}

/** One card by id (detail page header). */
export function useChurnCard(id: UUID | null) {
  return useQuery({
    queryKey: sbKeys.churnCard(id ?? ('none' as UUID)),
    queryFn: () => churningApi.fetchChurnCard(id!),
    enabled: id != null,
  })
}

export function useCreateChurnCard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (card: ChurnCardInsert) => churningApi.createChurnCard(card),
    onSuccess: () => invalidateChurning(qc),
  })
}

export function useUpdateChurnCard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: UUID; patch: Partial<ChurnCardInsert> }) =>
      churningApi.updateChurnCard(id, patch),
    onSuccess: () => invalidateChurning(qc),
  })
}

export function useDeleteChurnCard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => churningApi.deleteChurnCard(id),
    onSuccess: () => invalidateChurning(qc),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not delete card'),
  })
}

/** A card's bonuses, nearest spend-by date first. */
export function useChurnBonuses(cardId: UUID | null) {
  return useQuery({
    queryKey: sbKeys.churnBonuses(cardId ?? ('none' as UUID)),
    queryFn: () => churningApi.fetchChurnBonuses(cardId!),
    enabled: cardId != null,
  })
}

/** Every bonus across cards (deadlines widget). */
export function useAllChurnBonuses() {
  return useQuery({ queryKey: sbKeys.allChurnBonuses, queryFn: churningApi.fetchAllChurnBonuses })
}

export function useCreateChurnBonus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (bonus: ChurnBonusInsert) => churningApi.createChurnBonus(bonus),
    onSuccess: () => invalidateChurning(qc),
  })
}

export function useUpdateChurnBonus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: UUID; patch: Partial<ChurnBonusInsert> }) =>
      churningApi.updateChurnBonus(id, patch),
    onSuccess: () => invalidateChurning(qc),
  })
}

export function useDeleteChurnBonus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => churningApi.deleteChurnBonus(id),
    onSuccess: () => invalidateChurning(qc),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not delete bonus'),
  })
}

/** A card's credits, soonest reset first. */
export function useChurnCredits(cardId: UUID | null) {
  return useQuery({
    queryKey: sbKeys.churnCredits(cardId ?? ('none' as UUID)),
    queryFn: () => churningApi.fetchChurnCredits(cardId!),
    enabled: cardId != null,
  })
}

export function useCreateChurnCredit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (credit: ChurnCreditInsert) => churningApi.createChurnCredit(credit),
    onSuccess: () => invalidateChurning(qc),
  })
}

export function useUpdateChurnCredit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: UUID; patch: Partial<ChurnCreditInsert> }) =>
      churningApi.updateChurnCredit(id, patch),
    onSuccess: () => invalidateChurning(qc),
  })
}

export function useDeleteChurnCredit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => churningApi.deleteChurnCredit(id),
    onSuccess: () => invalidateChurning(qc),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not delete credit'),
  })
}

/** Every credit across the caller's cards, joined to card names (deadlines widget,
 *  "credits needing attention" section). */
export function useAllChurnCredits() {
  return useQuery({ queryKey: sbKeys.allChurnCredits, queryFn: churningApi.fetchAllChurnCredits })
}

/** One transaction by id (credit auto-detection "View transaction" subtext). */
export function useTransaction(id: UUID | null) {
  return useQuery({
    queryKey: ['sb', 'transactions', 'byId', id ?? ('none' as UUID)] as const,
    queryFn: () => txns.fetchTransactionById(id!),
    enabled: id != null,
  })
}

/** Qualifying outflow spend for a bonus window on the card's linked account. */
export function useBonusQualifyingSpend(
  accountId: UUID | null,
  startDate: string | null,
  endDate: string | null,
) {
  return useQuery({
    queryKey: ['sb', 'churning', 'qualifyingSpend', accountId, startDate, endDate] as const,
    queryFn: () =>
      churningApi.fetchQualifyingSpend({
        accountId: accountId!,
        startDate: startDate!,
        endDate: endDate!,
      }),
    enabled: accountId != null && startDate != null && endDate != null,
  })
}
