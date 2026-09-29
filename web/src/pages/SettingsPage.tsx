// Settings — minimal Simplifi-style list: six sections (General, Accounts,
// Categories, Rules, Notifications, Data), each a list row that opens a simple
// sub-view, plus the delete-account danger row at the bottom. The backend
// Plaid Link tab / PLAID_LINK_SUCCESS message-listener flow is preserved from
// the previous page (don't reinvent it). Deliberately excluded: tags,
// recurring-series management, dashboard customization, investments/net worth.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ArrowLeft,
  Bell,
  ChevronRight,
  Database,
  Download,
  Eye,
  EyeOff,
  FolderCog,
  Gamepad2,
  Landmark,
  ListChecks,
  Monitor,
  Moon,
  Pencil,
  Plug,
  Plus,
  RotateCcw,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  User,
  UserX,
  Wand2,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { InstitutionLogo } from '@/components/finance/InstitutionLogo'
import { PlaidCredentialsCard } from '@/components/finance/PlaidCredentialsCard'
import { CategoryIcon } from '@/components/finance/CategoryIcon'
import { BackfillPromptDialog } from '@/components/finance/BackfillPromptDialog'
import { NewAccountDialog } from '@/components/finance/NewAccountDialog'
import { InstallAppRow } from '@/components/InstallAppRow'
import ConfirmDialog from '@/components/ConfirmDialog'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { useAuth } from '@/lib/auth'
import { autoCategorize, fetchCategorizeStatus } from '@/data/aiCategorize'
import * as disc from '@/data/discretionary'
import * as churnApi from '@/data/churning'
import {
  sbKeys,
  usePlaidItems,
  useDeletePlaidItem,
  useMyProfile,
  useUpdateMyProfile,
  useDeleteMyAccount,
  useCategories,
  useRules,
  useAccounts,
} from '@/data/hooks'
import * as accts from '@/data/accounts'
import * as cats from '@/data/categories'
import {
  fetchMerchantMemory,
  forgetMerchant,
  fetchTransactionsRange,
} from '@/data/transactions'
import { plaidLinkUrl, plaidReconnectUrl } from '@/data/sync'
import { openWarmTab, isTrustedMessageOrigin } from '@/data/backend'
import { formatShortDate } from '@/lib/dates'
import { setDefaultCurrency } from '@/lib/money'
import { transactionsToCsv, downloadCsv } from '@/lib/exportCsv'
import type { Account, Category, CategoryRule, RuleDirection, UUID } from '@/types/domain'
import { cn } from '@/lib/utils'

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card'

/** Settings list row: 40px icon well + 18px label + trailing chevron. */
function SettingsRow({
  icon,
  label,
  meta,
  onClick,
  destructive = false,
}: {
  icon: ReactNode
  label: string
  meta?: string
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-4 rounded-lg p-4 text-left transition-colors motion-reduce:transition-none',
        destructive ? 'hover:bg-error-container' : 'hover:bg-surface-variant',
        focusRing,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container transition-colors motion-reduce:transition-none',
          destructive
            ? 'text-destructive group-hover:bg-destructive group-hover:text-destructive-foreground'
            : 'text-primary group-hover:bg-primary-container group-hover:text-on-primary-container',
        )}
      >
        {icon}
      </span>
      <span
        className={cn(
          'flex-1 text-lg leading-7',
          destructive ? 'text-destructive' : 'text-foreground',
        )}
      >
        {label}
      </span>
      {meta && <span className="text-xs font-semibold text-muted-foreground">{meta}</span>}
      {!destructive && <ChevronRight aria-hidden className="h-5 w-5 shrink-0 text-outline" />}
    </button>
  )
}

/** Sub-view shell: back button + title, then the section content. */
function SectionView({
  title,
  onBack,
  children,
}: {
  title: string
  onBack: () => void
  children: ReactNode
}) {
  return (
    <div className="pt-4 md:pt-6">
      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to Settings"
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-full text-foreground transition-colors hover:bg-surface-variant motion-reduce:transition-none',
            focusRing,
          )}
        >
          <ArrowLeft aria-hidden className="h-5 w-5" />
        </button>
        <h2 className="text-2xl font-semibold leading-8 text-foreground">{title}</h2>
      </div>
      {children}
    </div>
  )
}

type Section = 'general' | 'accounts' | 'categories' | 'rules' | 'ai' | 'notifications' | 'data' | 'gameTypes' | 'hiddenCredits' | 'watched'

const SECTIONS: { id: Section; label: string; Icon: typeof User }[] = [
  { id: 'general', label: 'General', Icon: User },
  { id: 'accounts', label: 'Accounts', Icon: Landmark },
  { id: 'categories', label: 'Categories', Icon: FolderCog },
  { id: 'rules', label: 'Rules', Icon: Wand2 },
  { id: 'ai', label: 'AI Categorization', Icon: Sparkles },
  { id: 'notifications', label: 'Notifications', Icon: Bell },
  { id: 'data', label: 'Data', Icon: Database },
  { id: 'gameTypes', label: 'Game types', Icon: Gamepad2 },
  { id: 'hiddenCredits', label: 'Card credits', Icon: EyeOff },
  { id: 'watched', label: 'Watched categories', Icon: ListChecks },
]

export default function SettingsPage() {
  const { user, signOut } = useAuth()
  const { data: banks = [] } = usePlaidItems()
  const [section, setSection] = useState<Section | null>(null)
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()

  // ?setup=1 (fresh signup via the manual-account dialog, or AppLayout): drop
  // straight into the Accounts section where the Plaid Link flow lives.
  useEffect(() => {
    if (searchParams.get('setup') === '1') setSection('accounts')
  }, [searchParams])

  // ── Plaid Link tab flow (preserved verbatim from the previous page) ──────
  const messageListenerRef = useRef<((e: MessageEvent) => void) | null>(null)
  const [backfillItem, setBackfillItem] = useState<{
    itemId: string
    institutionName: string
  } | null>(null)

  // Clean up any dangling message listener when the component unmounts.
  useEffect(() => {
    return () => {
      if (messageListenerRef.current) {
        window.removeEventListener('message', messageListenerRef.current)
        messageListenerRef.current = null
      }
    }
  }, [])

  // Shared PLAID_LINK_SUCCESS handler for both the fresh-link (addBank) and
  // update-mode (reconnectBank) tabs. A fresh link carries `new_account` and
  // opens the backfill prompt; a reconnect has no `new_account` (the backend's
  // /link/claim already kicks the backfill), so we just refresh + toast.
  function handleLinkSuccess(e: MessageEvent) {
    // Trust PLAID_LINK_SUCCESS only from the backend-hosted /link page (its origin
    // is VITE_BACKEND_URL) or same-origin — never an arbitrary window that could
    // forge a message and trigger a spurious backfill/refresh.
    if (!isTrustedMessageOrigin(e.origin)) return
    if (e.data?.type !== 'PLAID_LINK_SUCCESS') return
    const data = e.data.data as {
      item_id: string
      institution?: string
      new_account?: unknown
    }
    if (data.new_account) {
      setBackfillItem({ itemId: data.item_id, institutionName: data.institution ?? 'New bank' })
    } else {
      // Reconnect succeeded — refresh what a repaired connection can change.
      void queryClient.invalidateQueries({ queryKey: ['sb', 'plaidItems'] })
      void queryClient.invalidateQueries({ queryKey: ['sb', 'accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['sb', 'transactions'] })
      toast.success(`${data.institution ?? 'Bank'} reconnected`)
    }
    if (messageListenerRef.current) {
      window.removeEventListener('message', messageListenerRef.current)
      messageListenerRef.current = null
    }
  }

  // Register the shared success listener, replacing any previous one, then open
  // the given hosted-page tab. Mirrors the add/remove lifecycle so listeners
  // never leak (also cleaned up on unmount).
  async function openPlaidTab(resolveUrl: () => Promise<string>, errorMsg: string) {
    if (messageListenerRef.current) {
      window.removeEventListener('message', messageListenerRef.current)
    }
    messageListenerRef.current = handleLinkSuccess
    window.addEventListener('message', handleLinkSuccess)
    try {
      await openWarmTab(resolveUrl)
    } catch (e) {
      window.removeEventListener('message', handleLinkSuccess)
      messageListenerRef.current = null
      toast.error(e instanceof Error ? e.message : errorMsg)
    }
  }

  function addBank() {
    void openPlaidTab(plaidLinkUrl, 'Could not open Plaid Link')
  }

  function reconnectBank(itemId: string) {
    void openPlaidTab(() => plaidReconnectUrl(itemId), 'Could not open Plaid Link')
  }

  // ── Delete account (3-step confirm; useDeleteMyAccount must not regress) ──
  const deleteMyAccount = useDeleteMyAccount()
  const [confirmDeleteAccountOpen, setConfirmDeleteAccountOpen] = useState(false)
  const [deleteAccountStep, setDeleteAccountStep] = useState<1 | 2 | 3>(1)

  const email = user?.email ?? ''

  if (section === 'general')
    return <GeneralSection onBack={() => setSection(null)} />
  if (section === 'accounts')
    return (
      <AccountsSection
        onBack={() => setSection(null)}
        addBank={addBank}
        reconnectBank={reconnectBank}
        highlightSetup={searchParams.get('setup') === '1'}
      />
    )
  if (section === 'categories') return <CategoriesSection onBack={() => setSection(null)} />
  if (section === 'rules') return <RulesSection onBack={() => setSection(null)} />
  if (section === 'ai') return <AiSection onBack={() => setSection(null)} />
  if (section === 'notifications')
    return <NotificationsSection onBack={() => setSection(null)} />
  if (section === 'data') return <DataSection onBack={() => setSection(null)} />
  if (section === 'gameTypes') return <GameTypesSection onBack={() => setSection(null)} />
  if (section === 'hiddenCredits')
    return <HiddenCreditsSection onBack={() => setSection(null)} />
  if (section === 'watched') return <WatchedCategoriesSection onBack={() => setSection(null)} />

  return (
    <div className="space-y-6 pt-4 md:pt-6">
      <div>
        <h1 className="text-2xl font-semibold leading-8 text-foreground">Settings</h1>
        {email && <p className="mt-1 text-sm text-muted-foreground">Signed in as {email}</p>}
      </div>

      <section className="card-surface p-2 md:p-3" aria-label="Settings sections">
        <div className="space-y-1">
          {SECTIONS.map(({ id, label, Icon }) => (
            <SettingsRow
              key={id}
              icon={<Icon aria-hidden className="h-5 w-5" />}
              label={label}
              meta={
                id === 'accounts' && banks.length > 0
                  ? `${banks.length} linked`
                  : undefined
              }
              onClick={() => setSection(id)}
            />
          ))}
        </div>
      </section>

      <section className="card-surface p-2 md:p-3" aria-label="Danger zone">
        <SettingsRow
          icon={<UserX aria-hidden className="h-5 w-5" />}
          label="Delete account"
          onClick={() => {
            setDeleteAccountStep(1)
            setConfirmDeleteAccountOpen(true)
          }}
          destructive
        />
      </section>

      {backfillItem && (
        <BackfillPromptDialog
          open={!!backfillItem}
          institutionName={backfillItem.institutionName}
          itemId={backfillItem.itemId}
          onClose={() => setBackfillItem(null)}
        />
      )}

      {/* Delete account — 3-step: explanation → impact list → drag-to-confirm slider */}
      <DeleteAccountDialog
        open={confirmDeleteAccountOpen}
        step={deleteAccountStep}
        isPending={deleteMyAccount.isPending}
        onStepChange={setDeleteAccountStep}
        onClose={() => setConfirmDeleteAccountOpen(false)}
        onConfirm={() => {
          toast.promise(
            deleteMyAccount.mutateAsync().then(() => {
              setConfirmDeleteAccountOpen(false)
              void signOut()
            }),
            {
              loading: 'Deleting account…',
              success: 'Account deleted.',
              error: (e) =>
                e instanceof Error ? e.message : 'Could not delete account',
            },
          )
        }}
      />
    </div>
  )
}

// ─── General: display name, currency, theme ────────────────────────────────

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY']

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const

const emptySubscribe = () => () => {}

function GeneralSection({ onBack }: { onBack: () => void }) {
  const { data: profile } = useMyProfile()
  const updateProfile = useUpdateMyProfile()
  const { theme, setTheme } = useTheme()
  // next-themes only knows the stored theme on the client — render selection after
  // hydration (client snapshot true, server snapshot false) to avoid a mismatch flash.
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false)

  const [firstName, setFirstName] = useState(profile?.first_name ?? '')
  const [lastName, setLastName] = useState(profile?.last_name ?? '')
  const [savedName, setSavedName] = useState({
    first: profile?.first_name ?? '',
    last: profile?.last_name ?? '',
  })
  useEffect(() => {
    const f = profile?.first_name ?? ''
    const l = profile?.last_name ?? ''
    setFirstName(f)
    setLastName(l)
    setSavedName({ first: f, last: l })
  }, [profile?.first_name, profile?.last_name])

  const nameDirty = firstName !== savedName.first || lastName !== savedName.last

  async function saveName() {
    try {
      await updateProfile.mutateAsync({
        first_name: firstName.trim() || null,
        last_name: lastName.trim() || null,
      })
      setSavedName({ first: firstName, last: lastName })
      toast.success('Name updated')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save name')
    }
  }

  function changeCurrency(code: string) {
    setDefaultCurrency(code)
    toast.promise(updateProfile.mutateAsync({ currency: code }), {
      loading: 'Saving currency…',
      success: `Currency set to ${code}`,
      error: (e) => (e instanceof Error ? e.message : 'Could not save currency'),
    })
  }

  function changeTheme(value: 'light' | 'dark' | 'system') {
    setTheme(value)
    // Persist server-side too so other devices (and a fresh login) pick it up.
    void updateProfile.mutateAsync({ theme: value }).catch((e) => {
      toast.error(e instanceof Error ? e.message : 'Could not save theme')
    })
  }

  return (
    <SectionView title="General" onBack={onBack}>
      <div className="space-y-6">
        <section className="card-surface p-6">
          <h3 className="mb-4 text-xl font-medium leading-7 text-foreground">Display name</h3>
          <p className="mb-4 -mt-2 text-sm text-muted-foreground">
            Used in the dashboard greeting (e.g. &ldquo;Good morning, Dara.&rdquo;). Leave
            blank to use the household default.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="settings-first-name">First name</Label>
              <Input
                id="settings-first-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                autoComplete="given-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="settings-last-name">Last name</Label>
              <Input
                id="settings-last-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                autoComplete="family-name"
              />
            </div>
          </div>
          <div className="mt-4">
            <Button
              type="button"
              onClick={() => void saveName()}
              disabled={!nameDirty || updateProfile.isPending}
            >
              {updateProfile.isPending ? 'Saving…' : 'Save name'}
            </Button>
          </div>
        </section>

        <section className="card-surface p-6">
          <h3 className="mb-1 text-xl font-medium leading-7 text-foreground">Currency</h3>
          <p className="mb-4 text-sm text-muted-foreground">
            Used everywhere amounts are shown.
          </p>
          <div className="max-w-xs">
            <Label htmlFor="settings-currency" className="sr-only">
              Currency
            </Label>
            <Select
              value={profile?.currency ?? 'USD'}
              onValueChange={(v) => changeCurrency(v)}
              disabled={updateProfile.isPending}
            >
              <SelectTrigger id="settings-currency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </section>

        <section className="card-surface p-6">
          <h3 className="mb-4 text-xl font-medium leading-7 text-foreground">Appearance</h3>
          <div className="grid grid-cols-3 gap-4" role="group" aria-label="Theme">
            {THEME_OPTIONS.map(({ value, label, Icon }) => {
              const selected = mounted && theme === value
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => changeTheme(value)}
                  className={cn(
                    'flex min-h-[44px] flex-col items-center justify-center gap-2 rounded-lg border-2 p-4 transition-colors motion-reduce:transition-none',
                    selected
                      ? 'border-primary bg-card text-primary'
                      : 'border-outline-variant/60 bg-surface-container-high text-muted-foreground hover:bg-surface-variant',
                    focusRing,
                  )}
                >
                  <Icon aria-hidden className="h-6 w-6" />
                  <span className="text-sm font-medium">{label}</span>
                </button>
              )
            })}
          </div>
        </section>
        <section className="card-surface p-6">
          <h3 className="mb-1 text-xl font-medium leading-7 text-foreground">Install app</h3>
          <p className="mb-4 text-sm text-muted-foreground">
            Add PocketLens to your home screen for quick access.
          </p>
          <InstallAppRow />
        </section>
      </div>
    </SectionView>
  )
}

// ─── Accounts: Plaid items + per-account rename / hide / unhide ─────────────

const iconBtn =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary motion-reduce:transition-none'

function AccountRow({
  account,
  editing,
  draftName,
  onDraftChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onToggleActive,
  busy,
}: {
  account: Account
  editing: boolean
  draftName: string
  onDraftChange: (v: string) => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  onToggleActive: (active: boolean) => void
  busy: boolean
}) {
  const meta = [
    account.official_name,
    account.mask ? `••${account.mask}` : null,
    account.type,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className={cn('flex items-center gap-2 py-3', !account.is_active && 'opacity-60')}>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-2">
            <Input
              value={draftName}
              onChange={(e) => onDraftChange(e.target.value)}
              autoFocus
              aria-label="Account name"
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSaveEdit()
                if (e.key === 'Escape') onCancelEdit()
              }}
            />
            <Button
              type="button"
              size="sm"
              onClick={onSaveEdit}
              disabled={busy || draftName.trim().length === 0}
            >
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancelEdit}>
              Cancel
            </Button>
          </div>
        ) : (
          <>
            <p className="truncate text-base font-medium text-foreground">{account.name}</p>
            {(meta || !account.is_active) && (
              <p className="truncate text-xs text-muted-foreground">
                {meta}
                {!account.is_active && (meta ? ' · Hidden from totals' : 'Hidden from totals')}
              </p>
            )}
          </>
        )}
      </div>
      {!editing && (
        <>
          <button
            type="button"
            title={account.is_active ? 'Hide from totals' : 'Show in totals'}
            aria-label={`${account.is_active ? 'Hide' : 'Show'} ${account.name}`}
            onClick={() => onToggleActive(!account.is_active)}
            disabled={busy}
            className={cn(iconBtn, focusRing, 'disabled:opacity-60')}
          >
            {account.is_active ? (
              <Eye aria-hidden className="h-4 w-4" />
            ) : (
              <EyeOff aria-hidden className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            title="Rename account"
            aria-label={`Rename ${account.name}`}
            onClick={onStartEdit}
            disabled={busy}
            className={cn(iconBtn, focusRing, 'disabled:opacity-60')}
          >
            <Pencil aria-hidden className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  )
}

function AccountsSection({
  onBack,
  addBank,
  reconnectBank,
  highlightSetup = false,
}: {
  onBack: () => void
  addBank: () => void
  reconnectBank: (itemId: string) => void
  highlightSetup?: boolean
}) {
  const queryClient = useQueryClient()
  const { data: items = [] } = usePlaidItems()
  // Include hidden accounts so they can be unhidden here.
  const { data: accounts = [] } = useQuery({
    queryKey: [...sbKeys.accounts, 'all'],
    queryFn: () => accts.fetchAccounts({ includeInactive: true }),
  })
  const deleteItem = useDeletePlaidItem()

  const [confirmDeleteBank, setConfirmDeleteBank] = useState<{
    id: string
    name: string
  } | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  const invalidateAccounts = () => {
    void queryClient.invalidateQueries({ queryKey: sbKeys.accounts })
  }

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      accts.renameAccount(id, name),
    onSuccess: () => {
      invalidateAccounts()
      setEditingId(null)
      toast.success('Account renamed')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not rename account'),
  })
  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      active ? accts.unhideAccount(id) : accts.hideAccount(id),
    onSuccess: (_d, v) => {
      invalidateAccounts()
      toast.success(v.active ? 'Account shown in totals' : 'Account hidden from totals')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not update account'),
  })
  const busy = rename.isPending || setActive.isPending

  const accountsByItem = useMemo(() => {
    const map = new Map<string, Account[]>()
    for (const a of accounts) {
      if (!a.plaid_item_id) continue
      const list = map.get(a.plaid_item_id) ?? []
      list.push(a)
      map.set(a.plaid_item_id, list)
    }
    return map
  }, [accounts])

  function startEdit(account: Account) {
    setEditingId(account.id)
    setDraftName(account.name)
  }
  function saveEdit() {
    if (!editingId) return
    const name = draftName.trim()
    if (!name) return
    rename.mutate({ id: editingId, name })
  }

  return (
    <SectionView title="Accounts" onBack={onBack}>
      <div className="space-y-6">
        <PlaidCredentialsCard highlight={highlightSetup} />
        {items.length === 0 ? (
          <div className="card-surface rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No banks linked yet.
          </div>
        ) : (
          items.map((item) => (
            <section key={item.id} className="card-surface p-6">
              <div className="flex items-center gap-4">
                <InstitutionLogo logo={item.institution_logo} className="h-10 w-10 shrink-0" />
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-lg font-medium leading-7 text-foreground">
                    {item.institution_name ?? 'Bank'}
                  </h3>
                  {item.last_synced_at && (
                    <p className="text-xs text-muted-foreground">
                      Synced {formatShortDate(item.last_synced_at)}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  title="Reconnect"
                  aria-label={`Reconnect ${item.institution_name ?? 'bank'}`}
                  onClick={() => reconnectBank(item.id)}
                  className={cn(iconBtn, focusRing)}
                >
                  <Plug aria-hidden className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  title="Disconnect"
                  aria-label={`Disconnect ${item.institution_name ?? 'bank'}`}
                  onClick={() =>
                    setConfirmDeleteBank({
                      id: item.id,
                      name: item.institution_name ?? 'this bank',
                    })
                  }
                  className={cn(
                    iconBtn,
                    focusRing,
                    'hover:bg-destructive/10 hover:text-destructive',
                  )}
                >
                  <Trash2 aria-hidden className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-2 divide-y divide-border">
                {(accountsByItem.get(item.id) ?? []).map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a}
                    editing={editingId === a.id}
                    draftName={draftName}
                    onDraftChange={setDraftName}
                    onStartEdit={() => startEdit(a)}
                    onCancelEdit={() => setEditingId(null)}
                    onSaveEdit={saveEdit}
                    onToggleActive={(active) => setActive.mutate({ id: a.id, active })}
                    busy={busy}
                  />
                ))}
              </div>
            </section>
          ))
        )}

        <section className="card-surface p-2 md:p-3">
          <div className="space-y-1">
            <SettingsRow
              icon={<Plus aria-hidden className="h-5 w-5" />}
              label="Add a bank"
              meta="Plaid"
              onClick={addBank}
            />
            <SettingsRow
              icon={<Pencil aria-hidden className="h-5 w-5" />}
              label="Add manual account"
              onClick={() => setManualOpen(true)}
            />
          </div>
        </section>
      </div>

      <NewAccountDialog open={manualOpen} onOpenChange={setManualOpen} />

      <ConfirmDialog
        open={!!confirmDeleteBank}
        title={`Disconnect ${confirmDeleteBank?.name ?? 'bank'}?`}
        message={`This permanently removes your ${confirmDeleteBank?.name ?? 'bank'} connection and deletes ALL accounts and transactions imported from it — checking, savings, credit cards, and any other accounts under that login. This cannot be undone.\n\nTo hide just one account while keeping the others, use the eye button on the account above instead.`}
        confirmLabel="Disconnect & delete everything"
        onConfirm={() => {
          if (!confirmDeleteBank) return
          toast.promise(deleteItem.mutateAsync(confirmDeleteBank.id), {
            loading: `Disconnecting ${confirmDeleteBank.name}…`,
            success: `${confirmDeleteBank.name} disconnected`,
            error: (e) => (e instanceof Error ? e.message : 'Could not disconnect bank'),
          })
          setConfirmDeleteBank(null)
        }}
        onCancel={() => setConfirmDeleteBank(null)}
      />
    </SectionView>
  )
}

// ─── Categories: add / rename / archive ────────────────────────────────────

const CATEGORY_PALETTE = [
  '#34C759',
  '#0A84FF',
  '#FF9F0A',
  '#FF453A',
  '#BF5AF2',
  '#FFD60A',
  '#64D2FF',
  '#98989D',
]

function CategoriesSection({ onBack }: { onBack: () => void }) {
  const queryClient = useQueryClient()
  const { data: categories = [] } = useCategories()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [color, setColor] = useState(CATEGORY_PALETTE[0])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: sbKeys.categories })
  }

  const save = useMutation({
    mutationFn: (cat: Partial<Category> & { name: string; color: string; icon: string }) =>
      cats.upsertCategory(cat),
    onSuccess: () => {
      invalidate()
      setAdding(false)
      setName('')
      setColor(CATEGORY_PALETTE[0])
      setEditingId(null)
      toast.success('Category saved')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save category'),
  })
  const archive = useMutation({
    mutationFn: (id: string) => cats.setCategoryActive(id, false),
    onSuccess: () => {
      invalidate()
      toast.success('Category archived')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not archive category'),
  })
  const busy = save.isPending || archive.isPending

  function addCategory() {
    const trimmed = name.trim()
    if (!trimmed) return
    save.mutate({
      name: trimmed,
      color,
      icon: 'tag.fill',
      sort_order: categories.length,
    })
  }

  function saveRename(cat: Category) {
    const trimmed = draftName.trim()
    if (!trimmed) return
    save.mutate({ id: cat.id, name: trimmed, color: cat.color, icon: cat.icon })
  }

  return (
    <SectionView title="Categories" onBack={onBack}>
      <div className="space-y-6">
        <section className="card-surface p-2 md:p-3">
          {categories.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No categories yet.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {categories.map((cat) => (
                <div key={cat.id} className="flex items-center gap-3 px-2 py-2.5">
                  <CategoryIcon category={cat} size={36} />
                  <div className="min-w-0 flex-1">
                    {editingId === cat.id ? (
                      <div className="flex items-center gap-2">
                        <Input
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          autoFocus
                          aria-label="Category name"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveRename(cat)
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                        />
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => saveRename(cat)}
                          disabled={busy || draftName.trim().length === 0}
                        >
                          Save
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <p className="truncate text-base font-medium text-foreground">{cat.name}</p>
                    )}
                  </div>
                  {editingId !== cat.id && (
                    <>
                      <button
                        type="button"
                        title="Rename"
                        aria-label={`Rename ${cat.name}`}
                        onClick={() => {
                          setEditingId(cat.id)
                          setDraftName(cat.name)
                        }}
                        disabled={busy}
                        className={cn(iconBtn, focusRing, 'disabled:opacity-60')}
                      >
                        <Pencil aria-hidden className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        title="Archive category"
                        aria-label={`Archive ${cat.name}`}
                        onClick={() => archive.mutate(cat.id)}
                        disabled={busy}
                        className={cn(
                          iconBtn,
                          focusRing,
                          'hover:bg-destructive/10 hover:text-destructive disabled:opacity-60',
                        )}
                      >
                        <Archive aria-hidden className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card-surface p-6">
          {adding ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="new-category-name">Name</Label>
                <Input
                  id="new-category-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  placeholder="e.g. Groceries"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addCategory()
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Color</Label>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Category color">
                  {CATEGORY_PALETTE.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Color ${c}`}
                      aria-pressed={color === c}
                      onClick={() => setColor(c)}
                      className={cn(
                        'h-9 w-9 rounded-full transition-transform motion-reduce:transition-none',
                        color === c && 'ring-2 ring-primary ring-offset-2 ring-offset-card',
                        focusRing,
                      )}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  onClick={addCategory}
                  disabled={busy || name.trim().length === 0}
                >
                  {save.isPending ? 'Adding…' : 'Add category'}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <SettingsRow
              icon={<Plus aria-hidden className="h-5 w-5" />}
              label="Add category"
              onClick={() => setAdding(true)}
            />
          )}
        </section>
      </div>
    </SectionView>
  )
}

// ─── Rules: keyword rules + learned merchant memory ────────────────────────

const DIRECTION_OPTIONS = [
  { value: 'any', label: 'Any direction' },
  { value: 'out', label: 'Money out' },
  { value: 'in', label: 'Money in' },
] as const

function RuleDialog({
  rule,
  categories,
  onClose,
}: {
  rule: CategoryRule | null // null = add
  categories: Category[]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [keyword, setKeyword] = useState(rule?.keyword ?? '')
  const [categoryId, setCategoryId] = useState<string>(rule?.category_id ?? '')
  const [direction, setDirection] = useState<string>(rule?.direction ?? 'any')
  const [minAmount, setMinAmount] = useState(
    rule?.min_amount != null ? String(rule.min_amount) : '',
  )
  const [maxAmount, setMaxAmount] = useState(
    rule?.max_amount != null ? String(rule.max_amount) : '',
  )
  const [saving, setSaving] = useState(false)

  const valid =
    keyword.trim().length > 0 &&
    categoryId.length > 0 &&
    (minAmount.trim() === '' || !Number.isNaN(Number(minAmount))) &&
    (maxAmount.trim() === '' || !Number.isNaN(Number(maxAmount)))

  async function save() {
    if (!valid) return
    setSaving(true)
    const payload = {
      keyword: keyword.trim(),
      categoryId: categoryId || null,
      direction: (direction === 'any' ? null : direction) as RuleDirection | null,
      minAmount: minAmount.trim() === '' ? null : Number(minAmount),
      maxAmount: maxAmount.trim() === '' ? null : Number(maxAmount),
    }
    try {
      if (rule) await cats.updateRule(rule.id, payload)
      else await cats.addRule(payload)
      void queryClient.invalidateQueries({ queryKey: sbKeys.rules })
      toast.success(rule ? 'Rule updated' : 'Rule added')
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save rule')
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !saving && !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit rule' : 'Add rule'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="rule-keyword">Keyword</Label>
            <Input
              id="rule-keyword"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              autoFocus
              placeholder="e.g. whole foods"
            />
            <p className="text-xs text-muted-foreground">
              Matches the merchant name or description (case-insensitive).
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rule-category">Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger id="rule-category">
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rule-direction">Direction (optional)</Label>
            <Select value={direction} onValueChange={setDirection}>
              <SelectTrigger id="rule-direction">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIRECTION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="rule-min">Min amount (optional)</Label>
              <Input
                id="rule-min"
                inputMode="decimal"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-max">Max amount (optional)</Label>
              <Input
                id="rule-max"
                inputMode="decimal"
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
                placeholder="No max"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!valid || saving}>
            {saving ? 'Saving…' : rule ? 'Save changes' : 'Add rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RulesSection({ onBack }: { onBack: () => void }) {
  const queryClient = useQueryClient()
  const { data: rules = [] } = useRules()
  // Include archived categories so rule targets still resolve to names.
  const { data: allCats = [] } = useQuery({
    queryKey: [...sbKeys.categories, 'all'],
    queryFn: () => cats.fetchCategories({ includeInactive: true }),
  })
  const { data: memory = {} } = useQuery({
    queryKey: ['sb', 'merchantMemory'],
    queryFn: fetchMerchantMemory,
  })
  const [dialog, setDialog] = useState<{ rule: CategoryRule | null } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<CategoryRule | null>(null)

  const nameById = useMemo(() => new Map(allCats.map((c) => [c.id, c.name])), [allCats])
  const learnedEntries = useMemo(() => Object.entries(memory), [memory])

  function invalidateRules() {
    void queryClient.invalidateQueries({ queryKey: sbKeys.rules })
  }

  function ruleBadges(rule: CategoryRule) {
    const badges: string[] = []
    if (rule.direction === 'in') badges.push('Money in')
    if (rule.direction === 'out') badges.push('Money out')
    if (rule.min_amount != null) badges.push(`≥ $${rule.min_amount}`)
    if (rule.max_amount != null) badges.push(`≤ $${rule.max_amount}`)
    if (rule.set_reimbursement) badges.push('Reimbursement')
    return badges
  }

  return (
    <SectionView title="Rules" onBack={onBack}>
      <div className="space-y-6">
        <section className="card-surface p-2 md:p-3">
          {rules.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No keyword rules yet.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {rules.map((rule) => (
                <div key={rule.id} className="flex items-center gap-3 px-2 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-medium text-foreground">
                      “{rule.keyword}”{' '}
                      <span className="font-normal text-muted-foreground">→</span>{' '}
                      {rule.category_id ? (nameById.get(rule.category_id) ?? 'Unknown') : '—'}
                    </p>
                    {ruleBadges(rule).length > 0 && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {ruleBadges(rule).join(' · ')}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    title="Edit rule"
                    aria-label={`Edit rule for ${rule.keyword}`}
                    onClick={() => setDialog({ rule })}
                    className={cn(iconBtn, focusRing)}
                  >
                    <Pencil aria-hidden className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    title="Delete rule"
                    aria-label={`Delete rule for ${rule.keyword}`}
                    onClick={() => setConfirmDelete(rule)}
                    className={cn(
                      iconBtn,
                      focusRing,
                      'hover:bg-destructive/10 hover:text-destructive',
                    )}
                  >
                    <Trash2 aria-hidden className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {learnedEntries.length > 0 && (
          <section className="card-surface p-6">
            <h3 className="mb-1 text-xl font-medium leading-7 text-foreground">Learned</h3>
            <p className="mb-3 text-sm text-muted-foreground">
              Remembered from how you categorize — these apply automatically.
            </p>
            <div className="divide-y divide-border">
              {learnedEntries.map(([key, categoryId]) => (
                <div key={key} className="flex items-center gap-3 py-2.5">
                  <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {key} <span className="text-muted-foreground">→</span>{' '}
                    {nameById.get(categoryId) ?? 'Unknown'}
                  </p>
                  <button
                    type="button"
                    title="Forget this mapping"
                    aria-label={`Forget learned mapping for ${key}`}
                    onClick={() => {
                      toast.promise(forgetMerchant(key), {
                        loading: 'Forgetting…',
                        success: 'Mapping forgotten',
                        error: (e) =>
                          e instanceof Error ? e.message : 'Could not forget mapping',
                      })
                      void queryClient.invalidateQueries({ queryKey: ['sb', 'merchantMemory'] })
                    }}
                    className={cn(
                      iconBtn,
                      focusRing,
                      'hover:bg-destructive/10 hover:text-destructive',
                    )}
                  >
                    <Trash2 aria-hidden className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="card-surface p-2 md:p-3">
          <SettingsRow
            icon={<Plus aria-hidden className="h-5 w-5" />}
            label="Add rule"
            onClick={() => setDialog({ rule: null })}
          />
        </section>
      </div>

      {dialog && (
        <RuleDialog
          rule={dialog.rule}
          categories={allCats.filter((c) => c.is_active !== false)}
          onClose={() => setDialog(null)}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete this rule?"
        message={`The rule for “${confirmDelete?.keyword ?? ''}” will stop auto-categorizing matching transactions.`}
        confirmLabel="Delete rule"
        onConfirm={() => {
          if (!confirmDelete) return
          toast.promise(cats.deleteRule(confirmDelete.id).then(() => invalidateRules()), {
            loading: 'Deleting…',
            success: 'Rule deleted',
            error: (e) => (e instanceof Error ? e.message : 'Could not delete rule'),
          })
          setConfirmDelete(null)
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </SectionView>
  )
}

// ─── Notifications: per-type reminder prefs + email digest ────────────────

interface NotifRowDef {
  label: string
  desc: string
  enabledKey: 'notify_credit_enabled' | 'notify_bonus_enabled' | 'notify_fee_enabled'
  daysKey: 'notify_credit_days' | 'notify_bonus_days' | 'notify_fee_days'
  fallbackDays: number
}

const NOTIF_ROWS: NotifRowDef[] = [
  {
    label: 'Card credit reminders',
    desc: 'Remind me before a card credit expires unused',
    enabledKey: 'notify_credit_enabled',
    daysKey: 'notify_credit_days',
    fallbackDays: 7,
  },
  {
    label: 'Signup bonus deadline reminders',
    desc: 'Remind me before a bonus spend deadline',
    enabledKey: 'notify_bonus_enabled',
    daysKey: 'notify_bonus_days',
    fallbackDays: 14,
  },
  {
    label: 'Annual fee / cancel-by reminders',
    desc: 'Remind me before an annual fee posts or a cancel-by date',
    enabledKey: 'notify_fee_enabled',
    daysKey: 'notify_fee_days',
    fallbackDays: 30,
  },
]

function NotifPrefRow({
  label,
  desc,
  enabled,
  days,
  fallbackDays,
  onToggle,
  onDays,
  saving,
}: {
  label: string
  desc: string
  enabled: boolean
  days: number | null | undefined
  fallbackDays: number
  onToggle: (v: boolean) => void
  onDays: (d: number) => void
  saving: boolean
}) {
  const [draft, setDraft] = useState(String(days ?? fallbackDays))
  useEffect(() => {
    setDraft(String(days ?? fallbackDays))
  }, [days, fallbackDays])

  const parsed = Number.parseInt(draft, 10)
  const daysValid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 365
  const dirty = draft !== String(days ?? fallbackDays)

  function commitDays() {
    if (!dirty || !daysValid) return
    onDays(parsed)
  }

  return (
    <div
      className={cn(
        'flex items-center gap-4 border-b border-border px-2 py-4 last:border-0',
        !enabled && 'opacity-60',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium text-foreground">{label}</p>
        <p className="text-sm text-muted-foreground">{desc}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Input
          className="w-20 text-center"
          inputMode="numeric"
          aria-label={`${label} — days before`}
          value={draft}
          disabled={!enabled || saving}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={commitDays}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitDays()
          }}
        />
        <span className="text-sm text-muted-foreground">days</span>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        disabled={saving}
        aria-label={label}
      />
    </div>
  )
}

function NotificationsSection({ onBack }: { onBack: () => void }) {
  const { data: profile } = useMyProfile()
  const updateProfile = useUpdateMyProfile()
  const saving = updateProfile.isPending

  function save(patch: Parameters<typeof updateProfile.mutateAsync>[0], label: string) {
    toast.promise(updateProfile.mutateAsync(patch), {
      loading: 'Saving…',
      success: label,
      error: (e) => (e instanceof Error ? e.message : 'Could not save'),
    })
  }

  return (
    <SectionView title="Notifications" onBack={onBack}>
      <div className="space-y-6">
        <section className="card-surface px-4 py-2">
          {NOTIF_ROWS.map((row) => (
            <NotifPrefRow
              key={row.enabledKey}
              label={row.label}
              desc={row.desc}
              enabled={profile?.[row.enabledKey] ?? true}
              days={profile?.[row.daysKey]}
              fallbackDays={row.fallbackDays}
              onToggle={(v) => save({ [row.enabledKey]: v }, v ? 'Reminders on' : 'Reminders off')}
              onDays={(d) => save({ [row.daysKey]: d }, `Reminding ${d} days ahead`)}
              saving={saving}
            />
          ))}
        </section>

        <section className="card-surface p-6">
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium text-foreground">Email digest</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Get the same reminders by email. Requires SMTP_HOST (and
                SMTP_USER/SMTP_PASS) configured on your backend — in-app reminders always
                work.
              </p>
            </div>
            <Switch
              checked={profile?.notify_email_enabled === true}
              onCheckedChange={(v) =>
                save({ notify_email_enabled: v === true }, v ? 'Email digest on' : 'Email digest off')
              }
              disabled={saving}
              aria-label="Email digest"
            />
          </div>
        </section>
      </div>
    </SectionView>
  )
}

// ─── AI categorization: provider, threshold, key status ────────────────────

const AI_THRESHOLD_OPTIONS = [0.5, 0.6, 0.7, 0.8, 0.9]

function AiSection({ onBack }: { onBack: () => void }) {
  const { data: profile } = useMyProfile()
  const updateProfile = useUpdateMyProfile()
  const saving = updateProfile.isPending
  const [running, setRunning] = useState(false)

  const { data: aiStatus } = useQuery({
    queryKey: ['categorize-status'],
    queryFn: fetchCategorizeStatus,
    staleTime: 60_000,
  })

  function save(patch: Parameters<typeof updateProfile.mutateAsync>[0], label: string) {
    toast.promise(updateProfile.mutateAsync(patch), {
      loading: 'Saving…',
      success: label,
      error: (e) => (e instanceof Error ? e.message : 'Could not save'),
    })
  }

  const enabled = profile?.ai_enabled ?? true
  const provider = profile?.ai_provider ?? 'jev'
  const threshold = profile?.ai_confidence_threshold ?? 0.7

  async function runNow() {
    setRunning(true)
    try {
      const stats = await autoCategorize()
      if (!stats) {
        toast.error('Could not reach the backend')
        return
      }
      if (stats.status === 'disabled') toast('AI categorization is disabled')
      else if (stats.status === 'misconfigured')
        toast.error('AI provider is misconfigured — check the backend API key')
      else
        toast.success(
          `Checked ${stats.checked}: ${stats.rules_applied} by rules, ${stats.from_cache} cached, ` +
            `${stats.ai_applied} by AI, ${stats.needs_review} need review`,
        )
    } catch {
      toast.error('AI categorization failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <SectionView title="AI Categorization" onBack={onBack}>
      <div className="space-y-6">
        <section className="card-surface p-6">
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium text-foreground">Auto-categorize with AI</p>
              <p className="mt-1 text-sm text-muted-foreground">
                After every Plaid sync and CSV import, the AI classifies whatever your
                rules and merchant memory couldn't. Your corrections always win — they
                teach the memory the AI can never override.
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={(v) => save({ ai_enabled: v === true }, v ? 'AI on' : 'AI off')}
              disabled={saving}
              aria-label="Auto-categorize with AI"
            />
          </div>
        </section>

        <section className="card-surface space-y-5 p-6">
          <div>
            <Label>Provider</Label>
            <Select
              value={provider}
              onValueChange={(v) => save({ ai_provider: v }, 'Provider saved')}
              disabled={saving || !enabled}
            >
              <SelectTrigger className="mt-2 w-full max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="jev">Jev (TypeSafe)</SelectItem>
                <SelectItem value="gemini">Gemini (stub — not implemented)</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-2 text-sm text-muted-foreground">
              Jev is a decision model, not a chatbot — it picks from your categories
              with calibrated confidence. Swap providers with one setting; no code
              changes.
            </p>
          </div>

          <div>
            <Label>Confidence threshold</Label>
            <Select
              value={String(threshold)}
              onValueChange={(v) => save({ ai_confidence_threshold: Number(v) }, 'Threshold saved')}
              disabled={saving || !enabled}
            >
              <SelectTrigger className="mt-2 w-full max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AI_THRESHOLD_OPTIONS.map((t) => (
                  <SelectItem key={t} value={String(t)}>
                    {Math.round(t * 100)}%{t === 0.7 ? ' (recommended)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-2 text-sm text-muted-foreground">
              Below this confidence the AI looks the merchant up once, tries again, and
              otherwise leaves the transaction in your review queue.
            </p>
          </div>
        </section>

        <section className="card-surface space-y-3 p-6">
          <p className="text-base font-medium text-foreground">API keys</p>
          <p className="text-sm text-muted-foreground">
            Keys live in the backend's environment — never in the database. Only
            presence is shown here.
          </p>
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Jev (JEV_API_KEY)</dt>
              <dd className="font-medium text-foreground">
                {aiStatus ? (aiStatus.jev_key_configured ? 'Configured' : 'Missing') : '…'}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Brave Search (BRAVE_API_KEY)</dt>
              <dd className="font-medium text-foreground">
                {aiStatus ? (aiStatus.brave_key_configured ? 'Configured' : 'Missing') : '…'}
              </dd>
            </div>
          </dl>
          <div className="pt-1">
            <Button onClick={() => void runNow()} disabled={running || !enabled}>
              {running ? 'Categorizing…' : 'Run now'}
            </Button>
          </div>
        </section>
      </div>
    </SectionView>
  )
}

// ─── Data: CSV import / export ────────────────────────────────────────────

function DataSection({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate()
  const { data: accounts = [] } = useAccounts()
  const [exporting, setExporting] = useState(false)

  async function exportAll() {
    setExporting(true)
    try {
      const txns = await fetchTransactionsRange('2000-01-01', '2100-01-01', {
        includeExcluded: true,
      })
      const accountsById = new Map(accounts.map((a) => [a.id, { name: a.name }]))
      const stamp = new Date().toISOString().slice(0, 10)
      downloadCsv(`transactions-${stamp}.csv`, transactionsToCsv(txns, accountsById))
      toast.success(`Exported ${txns.length} transactions`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not export transactions')
    } finally {
      setExporting(false)
    }
  }

  return (
    <SectionView title="Data" onBack={onBack}>
      <section className="card-surface p-2 md:p-3">
        <div className="space-y-1">
          <SettingsRow
            icon={<Upload aria-hidden className="h-5 w-5" />}
            label="Import transactions (CSV)"
            onClick={() => navigate('/transactions')}
          />
          <SettingsRow
            icon={<Download aria-hidden className="h-5 w-5" />}
            label={exporting ? 'Exporting…' : 'Export transactions (CSV)'}
            onClick={() => void exportAll()}
          />
        </div>
      </section>
    </SectionView>
  )
}

// ─── Delete Account Dialog (3-step — preserved verbatim; do not regress) ────

const IMPACT_ITEMS = [
  { icon: '↔', label: 'All transactions & splits' },
  { icon: '💳', label: 'Accounts & balance history' },
  { icon: '🏦', label: 'Linked bank connections' },
  { icon: '📊', label: 'Categories & budgets' },
  { icon: '🔁', label: 'Recurring charge tracking' },
  { icon: '↕', label: 'Transfer & reimbursement links' },
  { icon: '👤', label: 'Profile settings' },
]

// ─── Game types: discretionary game list (add / rename / remove) ────────────

function GameTypesSection({ onBack }: { onBack: () => void }) {
  const queryClient = useQueryClient()
  const { data: types = [], isLoading } = useQuery({
    queryKey: ['sb', 'discretionary', 'gameTypes'],
    queryFn: disc.fetchGameTypes,
  })
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['sb', 'discretionary', 'gameTypes'] })
  }

  const save = useMutation({
    mutationFn: async (n: string): Promise<void> => {
      if (editingId) {
        await disc.renameGameType(editingId, n)
        return
      }
      await disc.createGameType(n)
    },
    onSuccess: () => {
      invalidate()
      setAdding(false)
      setName('')
      setEditingId(null)
      toast.success('Game type saved')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save game type'),
  })
  const remove = useMutation({
    mutationFn: (id: string) => disc.deleteGameType(id),
    onSuccess: () => {
      invalidate()
      toast.success('Game type removed')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not remove game type'),
  })
  const busy = save.isPending || remove.isPending

  function submitAdd() {
    if (name.trim().length > 0) save.mutate(name.trim())
  }
  function submitRename() {
    if (editingId && draftName.trim().length > 0) save.mutate(draftName.trim())
  }

  return (
    <SectionView title="Game types" onBack={onBack}>
      <div className="space-y-6">
        <section className="card-surface p-2 md:p-3">
          {isLoading ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : types.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No game types yet.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {types.map((t) => (
                <div key={t.id} className="flex items-center gap-3 px-2 py-2.5">
                  <Gamepad2 aria-hidden className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    {editingId === t.id ? (
                      <div className="flex items-center gap-2">
                        <Input
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          autoFocus
                          aria-label="Game type name"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') submitRename()
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                        />
                        <Button type="button" size="sm" onClick={submitRename} disabled={busy || draftName.trim().length === 0}>
                          Save
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <p className="truncate text-base font-medium text-foreground">{t.name}</p>
                    )}
                  </div>
                  {editingId !== t.id && (
                    <>
                      <button
                        type="button"
                        title="Rename"
                        aria-label={`Rename ${t.name}`}
                        onClick={() => {
                          setEditingId(t.id)
                          setDraftName(t.name)
                        }}
                        disabled={busy}
                        className={cn(iconBtn, focusRing, 'disabled:opacity-60')}
                      >
                        <Pencil aria-hidden className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        title="Remove"
                        aria-label={`Remove ${t.name}`}
                        onClick={() => remove.mutate(t.id)}
                        disabled={busy}
                        className={cn(
                          iconBtn,
                          focusRing,
                          'hover:bg-destructive/10 hover:text-destructive disabled:opacity-60',
                        )}
                      >
                        <Trash2 aria-hidden className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card-surface p-6">
          {adding ? (
            <div className="flex items-center gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                aria-label="New game type name"
                placeholder="e.g. Chess"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitAdd()
                }}
              />
              <Button type="button" onClick={submitAdd} disabled={busy || name.trim().length === 0}>
                {save.isPending ? 'Adding…' : 'Add'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <SettingsRow
              icon={<Plus aria-hidden className="h-5 w-5" />}
              label="Add game type"
              onClick={() => setAdding(true)}
            />
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            A game type used by ledger entries cannot be removed — rename it instead.
          </p>
        </section>
      </div>
    </SectionView>
  )
}

// ─── Hidden card credits: restore list ──────────────────────────────────────

function HiddenCreditsSection({ onBack }: { onBack: () => void }) {
  const queryClient = useQueryClient()
  const { data: credits = [], isLoading } = useQuery({
    queryKey: ['sb', 'churning', 'credits', 'hidden'],
    queryFn: churnApi.fetchHiddenChurnCredits,
  })

  const restore = useMutation({
    mutationFn: (id: UUID) => churnApi.updateChurnCredit(id, { is_hidden: false }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sb', 'churning', 'credits', 'hidden'] })
      void queryClient.invalidateQueries({ queryKey: sbKeys.allChurnCredits })
      void queryClient.invalidateQueries({ queryKey: ['sb', 'churning', 'credits'] })
      toast.success('Credit restored')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not restore credit'),
  })

  return (
    <SectionView title="Card credits" onBack={onBack}>
      <div className="space-y-6">
        <section className="card-surface p-2 md:p-3">
          {isLoading ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : credits.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No hidden credits.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {credits.map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-2 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-medium text-foreground">
                      {c.program_label?.trim() || c.churn_cards?.card_name || c.credit_name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {c.credit_name}
                      {c.churn_cards?.card_name ? ` · ${c.churn_cards.card_name}` : ''}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => restore.mutate(c.id)}
                    disabled={restore.isPending}
                  >
                    <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden />
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
        <p className="text-xs text-muted-foreground">
          Hidden credits are excluded from every credit list, total, and count across the app.
        </p>
      </div>
    </SectionView>
  )
}

// ─── Watched categories: spending-plan subset ───────────────────────────────

const WATCHED_DEFAULTS = ['groceries', 'shopping', 'eating out', 'pregnancy craving']

function WatchedCategoriesSection({ onBack }: { onBack: () => void }) {
  const { data: profile } = useMyProfile()
  const updateProfile = useUpdateMyProfile()
  const { data: categories = [], isLoading } = useCategories()

  const active = useMemo(() => categories.filter((c) => c.is_active !== false), [categories])

  // Saved ids when set; otherwise the seed defaults matched by name.
  const initialIds = useMemo(() => {
    if (profile?.watched_categories && profile.watched_categories.length > 0) {
      const saved = new Set(profile.watched_categories)
      return active.filter((c) => saved.has(c.id)).map((c) => c.id)
    }
    const byName = new Map(active.map((c) => [c.name.trim().toLowerCase(), c.id]))
    return WATCHED_DEFAULTS.map((n) => byName.get(n)).filter((id): id is string => !!id)
  }, [profile?.watched_categories, active])

  const [selected, setSelected] = useState<string[] | null>(null)
  useEffect(() => {
    setSelected(null)
  }, [profile?.watched_categories])
  const current = selected ?? initialIds
  const dirty = selected !== null && selected.join(',') !== initialIds.join(',')

  function toggle(id: string) {
    const list = selected ?? initialIds
    setSelected(list.includes(id) ? list.filter((x) => x !== id) : [...list, id])
  }

  function save() {
    const list = selected ?? initialIds
    toast.promise(updateProfile.mutateAsync({ watched_categories: list }), {
      loading: 'Saving…',
      success: 'Watched categories saved',
      error: (e) => (e instanceof Error ? e.message : 'Could not save'),
    })
  }

  return (
    <SectionView title="Watched categories" onBack={onBack}>
      <div className="space-y-6">
        <section className="card-surface p-2 md:p-3">
          {isLoading ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : active.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No categories yet.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {active.map((cat) => {
                const checked = current.includes(cat.id)
                return (
                  <label
                    key={cat.id}
                    className="flex cursor-pointer items-center gap-3 px-2 py-2.5"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggle(cat.id)}
                      aria-label={`Watch ${cat.name}`}
                    />
                    <CategoryIcon category={cat} size={32} />
                    <span className="truncate text-base text-foreground">{cat.name}</span>
                  </label>
                )
              })}
            </div>
          )}
        </section>
        <section className="card-surface p-6">
          <p className="mb-4 text-sm text-muted-foreground">
            These categories appear in the Overview spending plan — a focused subset instead of
            every category.
          </p>
          <Button type="button" onClick={save} disabled={!dirty || updateProfile.isPending}>
            {updateProfile.isPending ? 'Saving…' : 'Save watched categories'}
          </Button>
        </section>
      </div>
    </SectionView>
  )
}

function DeleteAccountDialog({
  open,
  step,
  isPending,
  onStepChange,
  onClose,
  onConfirm,
}: {
  open: boolean
  step: 1 | 2 | 3
  isPending: boolean
  onStepChange: (s: 1 | 2 | 3) => void
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!isPending && !o) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg overflow-hidden p-0">
        {/* Step indicator */}
        <div className="flex items-center gap-2 border-b border-border px-6 pt-5 pb-4 pr-14">
          {([1, 2, 3] as const).map((s) => (
            <div
              key={s}
              className={cn(
                'h-1.5 flex-1 rounded-full transition-colors',
                s <= step ? 'bg-destructive' : 'bg-muted',
              )}
            />
          ))}
        </div>

        {step === 1 && (
          <DeleteStep1 onNext={() => onStepChange(2)} onCancel={onClose} />
        )}
        {step === 2 && (
          <DeleteStep2 onNext={() => onStepChange(3)} onBack={() => onStepChange(1)} onCancel={onClose} />
        )}
        {step === 3 && (
          <DeleteStep3 isPending={isPending} onConfirm={onConfirm} onCancel={onClose} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DeleteStep1({ onNext, onCancel }: { onNext: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-6 px-6 py-5">
      {/* Icon + headline */}
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-destructive/10">
          <UserX aria-hidden className="h-9 w-9 text-destructive" />
        </div>
        <h2 className="text-xl font-bold text-foreground">Delete your account?</h2>
      </div>

      {/* Explanation rows */}
      <div className="space-y-3">
        {[
          {
            icon: <Trash2 aria-hidden className="h-5 w-5 text-destructive shrink-0 mt-0.5" />,
            title: 'Everything is permanently erased',
            body: 'Your account and all data tied to it is deleted from our servers immediately. There is no grace period and no recovery.',
          },
          {
            icon: <span aria-hidden className="text-destructive shrink-0 mt-0.5 text-base leading-5">🏦</span>,
            title: 'Bank connections are severed',
            body: 'All Plaid bank connections are removed. Your banks are not notified — this only disconnects PocketLens from reading your data.',
          },
          {
            icon: <span aria-hidden className="text-destructive shrink-0 mt-0.5 text-base leading-5">⛔</span>,
            title: 'Cannot be undone',
            body: 'Once deleted, your account cannot be restored. You would need to create a new account and re-link your banks from scratch.',
          },
        ].map(({ icon, title, body }) => (
          <div
            key={title}
            className="flex items-start gap-3 rounded-lg bg-destructive/5 px-4 py-3"
          >
            {icon}
            <div>
              <p className="text-sm font-semibold text-foreground">{title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 pb-1">
        <Button type="button" variant="destructive" className="w-full" onClick={onNext}>
          Continue
        </Button>
        <Button type="button" variant="ghost" className="w-full" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function DeleteStep2({
  onNext,
  onBack,
  onCancel,
}: {
  onNext: () => void
  onBack: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex flex-col gap-5 px-6 py-5">
      <div className="text-center">
        <h2 className="text-xl font-bold text-foreground">What will be deleted</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every piece of data below is permanently removed.
        </p>
      </div>

      <div className="divide-y divide-border rounded-xl border border-destructive/25 overflow-hidden">
        {IMPACT_ITEMS.map(({ icon, label }) => (
          <div key={label} className="flex items-center gap-3 bg-destructive/5 px-4 py-2.5">
            <span aria-hidden className="text-base w-5 text-center shrink-0">{icon}</span>
            <span className="flex-1 text-sm text-foreground">{label}</span>
            <span aria-hidden className="text-destructive/60 text-xs font-semibold">✕</span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 pb-1">
        <Button type="button" variant="destructive" className="w-full" onClick={onNext}>
          I understand — continue
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" className="flex-1" onClick={onBack}>
            Back
          </Button>
          <Button type="button" variant="ghost" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

function DeleteStep3({
  isPending,
  onConfirm,
  onCancel,
}: {
  isPending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-6 px-6 py-8">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-destructive/10">
        <span aria-hidden className="text-4xl">⚠️</span>
      </div>
      <div className="text-center">
        <h2 className="text-xl font-bold text-foreground">Last chance</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Slide all the way to the right to permanently delete your account and all data.
          <br />
          <strong className="text-foreground">This action is irreversible.</strong>
        </p>
      </div>

      {isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <span className="animate-spin">⟳</span> Deleting account…
        </div>
      ) : (
        <DeleteSlider onConfirmed={onConfirm} />
      )}

      <Button
        type="button"
        variant="ghost"
        className="w-full"
        onClick={onCancel}
        disabled={isPending}
      >
        Cancel
      </Button>
    </div>
  )
}

// ─── Drag-to-confirm slider ─────────────────────────────────────────────────

/** The user must drag the thumb at least 90% of the track width before releasing
 *  to fire `onConfirmed`. Releases below that snap back to start. */
function DeleteSlider({ onConfirmed }: { onConfirmed: () => void }) {
  const THUMB_W = 56
  const THRESHOLD = 0.90

  const trackRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  const [trackW, setTrackW] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startOffset = useRef(0)

  // Measure track width (and re-measure on resize).
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth))
    ro.observe(el)
    setTrackW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const maxOffset = Math.max(0, trackW - THUMB_W)
  const progress = maxOffset > 0 ? Math.min(offset / maxOffset, 1) : 0

  const onPointerDown = (e: React.PointerEvent) => {
    if (confirmed) return
    dragging.current = true
    startX.current = e.clientX
    startOffset.current = offset
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current || confirmed) return
    const delta = e.clientX - startX.current
    setOffset(Math.min(Math.max(0, startOffset.current + delta), maxOffset))
  }

  const onPointerUp = () => {
    if (!dragging.current) return
    dragging.current = false
    if (progress >= THRESHOLD) {
      setOffset(maxOffset)
      setConfirmed(true)
      // Small delay so the user sees the "locked" state before the action fires.
      setTimeout(onConfirmed, 300)
    } else {
      // Snap back with CSS transition (applied via class when not dragging).
      setOffset(0)
    }
  }

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      aria-label="Slide to delete account"
      className="relative h-14 w-full max-w-sm select-none overflow-hidden rounded-full"
      style={{ background: `hsl(var(--destructive) / 0.12)` }}
    >
      {/* Fill */}
      <div
        className="absolute inset-y-0 left-0 rounded-full"
        style={{
          width: offset + THUMB_W,
          background: `hsl(var(--destructive) / ${0.2 + 0.4 * progress})`,
          transition: dragging.current ? 'none' : 'width 0.35s cubic-bezier(.4,0,.2,1)',
        }}
      />

      {/* Track label (fades out as thumb advances) */}
      <div
        className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-semibold text-destructive"
        style={{ opacity: Math.max(0, 0.8 - progress * 0.8) }}
      >
        Slide to delete
      </div>

      {/* Thumb */}
      <div
        className="absolute top-1 flex h-12 w-14 cursor-grab items-center justify-center rounded-full shadow-md active:cursor-grabbing"
        style={{
          left: offset,
          background: confirmed ? 'hsl(var(--destructive))' : 'hsl(var(--card))',
          transition: dragging.current ? 'none' : 'left 0.35s cubic-bezier(.4,0,.2,1), background 0.2s',
          touchAction: 'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span
          className="text-lg font-bold transition-colors"
          style={{ color: confirmed ? 'white' : 'hsl(var(--destructive))' }}
        >
          {confirmed ? '✓' : '›'}
        </span>
      </div>
    </div>
  )
}
