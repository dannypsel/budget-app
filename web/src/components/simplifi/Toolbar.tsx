// Simplifi-style chrome shared by Transactions and Reports: outline toolbar
// buttons with a caret that open a menu, single-select dropdowns, icon
// toggles, and the underlined page tab bar.

import type { ReactNode } from 'react'
import { ChevronDown, type LucideIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export const toolbarButtonClass =
  'inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-semibold text-foreground transition-colors hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50'

export function ToolbarButton({
  icon: Icon,
  label,
  caret = false,
  className,
  ...props
}: {
  icon?: LucideIcon
  label?: ReactNode
  caret?: boolean
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={cn(toolbarButtonClass, !label && 'px-2', className)} {...props}>
      {Icon && <Icon className="h-4 w-4" aria-hidden />}
      {label}
      {caret && <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
    </button>
  )
}

/** Toolbar button that opens arbitrary menu content. */
export function ToolbarMenu({
  icon,
  label,
  children,
  align = 'start',
  ariaLabel,
  contentClassName,
}: {
  icon?: LucideIcon
  label?: ReactNode
  children: ReactNode
  align?: 'start' | 'end'
  ariaLabel?: string
  contentClassName?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolbarButton icon={icon} label={label} caret={!!label} aria-label={ariaLabel} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className={cn('max-h-96 min-w-52 overflow-y-auto', contentClassName)}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Single-select toolbar dropdown (label shows the current option). */
export function SelectMenu<T extends string>({
  icon,
  value,
  options,
  onChange,
  ariaLabel,
  align = 'start',
}: {
  icon?: LucideIcon
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  ariaLabel: string
  align?: 'start' | 'end'
}) {
  const current = options.find((o) => o.value === value)?.label ?? value
  return (
    <ToolbarMenu icon={icon} label={current} align={align} ariaLabel={`${ariaLabel}: ${current}`}>
      <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
        {options.map((o) => (
          <DropdownMenuRadioItem key={o.value} value={o.value}>
            {o.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </ToolbarMenu>
  )
}

/** Pair of icon toggle buttons (e.g. pie / bar). */
export function IconToggle<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: { value: T; icon: LucideIcon; label: string }[]
  onChange: (v: T) => void
  ariaLabel: string
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md bg-surface-container-low p-0.5" role="group" aria-label={ariaLabel}>
      {options.map(({ value: v, icon: Icon, label }) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          aria-label={label}
          onClick={() => onChange(v)}
          className={cn(
            'flex h-8 w-9 items-center justify-center rounded',
            value === v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
        </button>
      ))}
    </div>
  )
}

/** Simplifi's underlined page tabs. */
export function UnderlineTabs<T extends string>({
  value,
  tabs,
  onChange,
  ariaLabel,
  trailing,
}: {
  value: T
  tabs: { value: T; label: ReactNode; onClose?: () => void }[]
  onChange: (v: T) => void
  ariaLabel: string
  trailing?: ReactNode
}) {
  return (
    <div className="flex items-end border-b border-border">
      <div role="tablist" aria-label={ariaLabel} className="no-scrollbar flex min-w-0 flex-1 overflow-x-auto">
        {tabs.map((t) => (
          <div key={t.value} className="group relative flex shrink-0 items-center">
            <button
              type="button"
              role="tab"
              aria-selected={value === t.value}
              onClick={() => onChange(t.value)}
              className={cn(
                'flex items-center gap-1.5 border-b-2 px-5 py-3 text-sm font-semibold transition-colors',
                value === t.value
                  ? 'border-primary text-primary'
                  : 'border-transparent text-foreground hover:text-primary',
                t.onClose && 'pr-7',
              )}
            >
              {t.label}
            </button>
            {t.onClose && (
              <button
                type="button"
                aria-label="Close tab"
                onClick={t.onClose}
                className="absolute right-1.5 rounded px-1 text-xs text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-1 pb-1.5 pl-2">{trailing}</div>}
    </div>
  )
}
