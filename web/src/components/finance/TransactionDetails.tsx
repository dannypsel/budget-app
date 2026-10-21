// Simplifi transaction-detail extras shown under the category grid: statement
// name, color flag + note, memo, tags, split editor, attachments, create-a-rule,
// and recurring-series actions. Local state is seeded per transaction id because
// the dialog receives a snapshot row that doesn't refresh after each save.

import { useMemo, useRef, useState } from 'react'
import { hierarchical } from '@/lib/categoryTree'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Flag, Paperclip, Plus, Repeat, Split, Trash2, Wand2, X } from 'lucide-react'
import { useAddRule, useCategories, useRecurringSeries, useSetRecurringStatus } from '@/data/hooks'
import * as extras from '@/data/txnExtras'
import { TAG_PALETTE } from '@/lib/tagColors'
import { formatCurrency } from '@/lib/money'
import { cn } from '@/lib/utils'
import {
  displayName,
  merchantKey,
  txnSplits,
  txnTags,
  USER_FLAG_COLORS,
  USER_FLAGS,
  type Transaction,
  type UserFlag,
  type UUID,
} from '@/types/domain'

const section = 'rounded-lg bg-surface-container-low px-3 py-2.5'
const label = 'mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

export function TransactionDetails({ txn }: { txn: Transaction }) {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not save')

  const [flag, setFlag] = useState<UserFlag | null>(txn.user_flag ?? null)
  const [flagNote, setFlagNote] = useState(txn.user_flag_note ?? '')
  const [notes, setNotes] = useState(txn.notes ?? '')
  const [tagNames, setTagNames] = useState(() => txnTags(txn))
  const [newTag, setNewTag] = useState('')
  const [lastId, setLastId] = useState(txn.id)
  if (txn.id !== lastId) {
    setLastId(txn.id)
    setFlag(txn.user_flag ?? null)
    setFlagNote(txn.user_flag_note ?? '')
    setNotes(txn.notes ?? '')
    setTagNames(txnTags(txn))
  }

  const saveFlag = useMutation({
    mutationFn: ({ f, note }: { f: UserFlag | null; note: string }) => extras.setTxnFlag(txn.id, f, note || null),
    onSuccess: refresh,
    onError,
  })
  const saveNotes = useMutation({ mutationFn: (n: string) => extras.setTxnNotes(txn.id, n), onSuccess: refresh, onError })
  const addTag = useMutation({
    mutationFn: (name: string) => extras.addTxnTagByName(txn.id, name, TAG_PALETTE[tagNames.length % TAG_PALETTE.length]),
    onSuccess: () => {
      refresh()
      qc.invalidateQueries({ queryKey: ['sb', 'tags'] })
    },
    onError,
  })
  const removeTag = useMutation({ mutationFn: (id: UUID) => extras.removeTxnTag(txn.id, id), onSuccess: refresh, onError })

  const statement = txn.original_description ?? txn.description
  return (
    <div className="mt-3 flex flex-col gap-2">
      {statement && statement !== displayName(txn) && (
        <div className={section}>
          <p className={label}>Statement name</p>
          <p className="break-words text-sm text-foreground">{statement}</p>
        </div>
      )}

      <div className={section}>
        <p className={label}>
          <Flag className="h-3.5 w-3.5" aria-hidden /> Flag
        </p>
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Flag color">
          <button
            type="button"
            role="radio"
            aria-checked={flag == null}
            aria-label="No flag"
            onClick={() => {
              setFlag(null)
              saveFlag.mutate({ f: null, note: '' })
            }}
            className={cn('flex h-6 w-6 items-center justify-center rounded-full border border-border text-muted-foreground', flag == null && 'ring-2 ring-primary')}
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
          {USER_FLAGS.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={flag === f}
              aria-label={`${f.toLowerCase()} flag`}
              onClick={() => {
                setFlag(f)
                saveFlag.mutate({ f, note: flagNote })
              }}
              className={cn('h-6 w-6 rounded-full', flag === f && 'ring-2 ring-primary ring-offset-2 ring-offset-card')}
              style={{ backgroundColor: USER_FLAG_COLORS[f] }}
            />
          ))}
        </div>
        {flag && (
          <input
            value={flagNote}
            onChange={(e) => setFlagNote(e.target.value)}
            onBlur={() => flagNote !== (txn.user_flag_note ?? '') && saveFlag.mutate({ f: flag, note: flagNote })}
            placeholder="Flag note (optional)"
            aria-label="Flag note"
            className="mt-2 w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm"
          />
        )}
      </div>

      <div className={section}>
        <p className={label}>Notes</p>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (txn.notes ?? '') && saveNotes.mutate(notes)}
          rows={2}
          placeholder="Add a note"
          aria-label="Notes"
          className="w-full resize-y rounded-md border border-border bg-card px-2 py-1.5 text-sm"
        />
      </div>

      <div className={section}>
        <p className={label}>Tags</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {tagNames.map((t) => (
            <span key={t.id} className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: `${t.color}22`, color: t.color }}>
              {t.name}
              <button
                type="button"
                aria-label={`Remove tag ${t.name}`}
                onClick={() => {
                  setTagNames((prev) => prev.filter((x) => x.id !== t.id))
                  removeTag.mutate(t.id)
                }}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const name = newTag.trim()
              if (!name || tagNames.some((t) => t.name.toLowerCase() === name.toLowerCase())) return
              setTagNames((prev) => [...prev, { id: `pending-${name}`, name, color: TAG_PALETTE[prev.length % TAG_PALETTE.length] }])
              setNewTag('')
              addTag.mutate(name)
            }}
            className="flex items-center gap-1"
          >
            <input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              placeholder="Add tag"
              aria-label="Add tag"
              className="w-28 rounded-md border border-border bg-card px-2 py-1 text-xs"
            />
            <button type="submit" aria-label="Add tag" className="text-primary">
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          </form>
        </div>
      </div>

      <SplitEditor txn={txn} onSaved={refresh} onError={onError} />
      <Attachments txn={txn} onError={onError} />
      <RuleAndRecurring txn={txn} />
    </div>
  )
}

function SplitEditor({ txn, onSaved, onError }: { txn: Transaction; onSaved: () => void; onError: (e: unknown) => void }) {
  const { data: categories = [] } = useCategories()
  const initial = () => txnSplits(txn).map((s) => ({ category_id: s.category_id, amount: String(s.amount) }))
  const [open, setOpen] = useState(txnSplits(txn).length > 0)
  const [rows, setRows] = useState(initial)
  const [lastId, setLastId] = useState(txn.id)
  if (txn.id !== lastId) {
    setLastId(txn.id)
    setRows(initial())
    setOpen(txnSplits(txn).length > 0)
  }
  const parsed = rows.map((r) => ({ category_id: r.category_id, amount: Number(r.amount) || 0 }))
  const remainder = extras.splitRemainder(txn.amount, parsed)
  const valid = rows.every((r) => r.category_id) && (rows.length === 0 || remainder === 0)
  const save = useMutation({
    mutationFn: () => extras.replaceSplits(txn.id, txn.amount, parsed),
    onSuccess: () => {
      toast.success(rows.length ? 'Split saved' : 'Split removed')
      onSaved()
    },
    onError,
  })

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true)
          if (rows.length === 0) setRows([{ category_id: txn.category_id ?? '', amount: String(txn.amount) }, { category_id: '', amount: '0' }])
        }}
        className={cn(section, 'flex items-center gap-2 text-left text-sm font-medium text-foreground hover:bg-accent')}
      >
        <Split className="h-4 w-4 text-muted-foreground" aria-hidden /> Split transaction
      </button>
    )
  }
  return (
    <div className={section}>
      <p className={label}>
        <Split className="h-3.5 w-3.5" aria-hidden /> Split
      </p>
      <div className="flex flex-col gap-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <select
              aria-label={`Split ${i + 1} category`}
              value={r.category_id}
              onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, category_id: e.target.value } : x)))}
              className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-sm"
            >
              <option value="">Category…</option>
              {hierarchical(categories).map(({ c, label }) => (
                <option key={c.id} value={c.id}>{label}</option>
              ))}
            </select>
            <input
              aria-label={`Split ${i + 1} amount`}
              inputMode="decimal"
              value={r.amount}
              onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
              className="w-24 rounded-md border border-border bg-card px-2 py-1 text-right text-sm tabular-nums"
            />
            <button type="button" aria-label={`Remove split ${i + 1}`} onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))} className="text-muted-foreground">
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <button type="button" onClick={() => setRows((prev) => [...prev, { category_id: '', amount: String(remainder) }])} className="text-primary">
          + Add split
        </button>
        <span className={cn('tabular-nums', remainder !== 0 && rows.length > 0 ? 'text-destructive' : 'text-muted-foreground')}>
          Remaining {formatCurrency(remainder)}
        </span>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        {txnSplits(txn).length > 0 && (
          <button type="button" onClick={() => { setRows([]); save.mutate() }} className="rounded-full px-3 py-1 text-xs text-muted-foreground hover:bg-accent">
            Remove split
          </button>
        )}
        <button
          type="button"
          disabled={!valid || rows.length === 0 || save.isPending}
          onClick={() => save.mutate()}
          className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          Save split
        </button>
      </div>
    </div>
  )
}

function Attachments({ txn, onError }: { txn: Transaction; onError: (e: unknown) => void }) {
  const qc = useQueryClient()
  const key = ['sb', 'attachments', txn.id] as const
  const { data: files = [] } = useQuery({ queryKey: key, queryFn: () => extras.fetchAttachments(txn.id) })
  const inputRef = useRef<HTMLInputElement>(null)
  const after = () => {
    qc.invalidateQueries({ queryKey: key })
    qc.invalidateQueries({ queryKey: ['sb', 'attachmentCounts'] })
  }
  const upload = useMutation({ mutationFn: (f: File) => extras.uploadAttachment(txn.id, f), onSuccess: after, onError })
  const remove = useMutation({ mutationFn: extras.deleteAttachment, onSuccess: after, onError })
  async function open(path: string) {
    try {
      window.open(await extras.attachmentUrl(path), '_blank', 'noopener,noreferrer')
    } catch (e) {
      onError(e)
    }
  }
  return (
    <div className={section}>
      <p className={label}>
        <Paperclip className="h-3.5 w-3.5" aria-hidden /> Attachments
      </p>
      <ul className="flex flex-col gap-1">
        {files.map((f) => (
          <li key={f.id} className="flex items-center gap-2 text-sm">
            <button type="button" onClick={() => void open(f.storage_path)} className="min-w-0 flex-1 truncate text-left text-primary hover:underline">
              {f.file_name}
            </button>
            <button type="button" aria-label={`Delete ${f.file_name}`} onClick={() => remove.mutate(f)} className="text-muted-foreground">
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) upload.mutate(f)
          e.target.value = ''
        }}
      />
      <button type="button" onClick={() => inputRef.current?.click()} disabled={upload.isPending} className="mt-1 text-xs font-medium text-primary disabled:opacity-50">
        {upload.isPending ? 'Uploading…' : '+ Add receipt or file'}
      </button>
    </div>
  )
}

function RuleAndRecurring({ txn }: { txn: Transaction }) {
  const addRule = useAddRule()
  const { data: series = [] } = useRecurringSeries()
  const setStatus = useSetRecurringStatus()
  const key = merchantKey(txn)
  const mine = useMemo(() => series.find((s) => s.merchantKey === key), [series, key])
  const [keyword, setKeyword] = useState(displayName(txn))
  const [ruleOpen, setRuleOpen] = useState(false)
  const [lastId, setLastId] = useState(txn.id)
  if (txn.id !== lastId) {
    setLastId(txn.id)
    setKeyword(displayName(txn))
    setRuleOpen(false)
  }

  return (
    <div className={cn(section, 'flex flex-col gap-2')}>
      {ruleOpen ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!keyword.trim() || !txn.category_id) return
            addRule.mutate(
              { keyword: keyword.trim().toLowerCase(), categoryId: txn.category_id, direction: txn.amount < 0 ? 'in' : 'out' },
              {
                onSuccess: () => {
                  toast.success(`Rule created: payee contains “${keyword.trim()}” → ${txn.categories?.name ?? 'category'}`)
                  setRuleOpen(false)
                },
                onError: () => toast.error('Could not create rule'),
              },
            )
          }}
          className="flex flex-col gap-1.5 text-sm"
        >
          <span className="text-xs text-muted-foreground">
            Future {txn.amount < 0 ? 'deposits' : 'charges'} whose payee contains
          </span>
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} aria-label="Rule keyword" className="rounded-md border border-border bg-card px-2 py-1 text-sm" />
          <span className="text-xs text-muted-foreground">
            get categorized as <strong className="text-foreground">{txn.categories?.name}</strong>
          </span>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRuleOpen(false)} className="rounded-full px-3 py-1 text-xs text-muted-foreground hover:bg-accent">
              Cancel
            </button>
            <button type="submit" disabled={addRule.isPending} className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50">
              Create rule
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          disabled={!txn.category_id}
          title={txn.category_id ? undefined : 'Categorize the transaction first'}
          onClick={() => setRuleOpen(true)}
          className="flex items-center gap-2 text-left text-sm font-medium text-foreground disabled:opacity-50"
        >
          <Wand2 className="h-4 w-4 text-muted-foreground" aria-hidden /> Create a rule from this transaction
        </button>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Repeat className="h-4 w-4 text-muted-foreground" aria-hidden />
        {mine ? (
          <>
            <span className="text-foreground">
              Recurring {mine.cadence} · {formatCurrency(Math.abs(mine.avgAmount))}
              {mine.status !== 'suggested' && <span className="text-muted-foreground"> ({mine.status})</span>}
            </span>
            {mine.status !== 'confirmed' && (
              <button type="button" onClick={() => setStatus.mutate({ merchantKey: key, status: 'confirmed' })} className="text-xs font-medium text-primary">
                Confirm series
              </button>
            )}
            {mine.status !== 'ignored' && (
              <button type="button" onClick={() => setStatus.mutate({ merchantKey: key, status: 'ignored' })} className="text-xs font-medium text-primary">
                Ignore series
              </button>
            )}
            <Link to="/recurring" className="text-xs font-medium text-primary">
              View series
            </Link>
          </>
        ) : (
          <span className="text-muted-foreground">Not part of a detected recurring series</span>
        )}
      </div>
    </div>
  )
}
