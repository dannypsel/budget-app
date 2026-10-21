// Register search input + Simplifi's "Shortcuts" drawer documenting the search
// syntax (lib/searchDsl SEARCH_SECTIONS). Clicking an example inserts it.

import { useState } from 'react'
import { Search, X, Zap } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { SEARCH_SECTIONS } from '@/lib/searchDsl'
import { cn } from '@/lib/utils'

export function TransactionSearchBox({
  value,
  onChange,
  className,
  placeholder = 'Search transactions...',
}: {
  value: string
  onChange: (v: string) => void
  className?: string
  placeholder?: string
}) {
  const [helpOpen, setHelpOpen] = useState(false)
  const insert = (syntax: string) => {
    const cur = value.trim()
    onChange(cur ? `${cur} ${syntax}` : syntax)
    setHelpOpen(false)
  }
  return (
    <div className={cn('relative flex-1', className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label="Search transactions"
        className="w-full card-surface border border-border py-3 pl-10 pr-36 text-sm text-foreground transition-colors placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="Clear search"
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          aria-label="Search syntax help"
          className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/15"
        >
          <Zap aria-hidden className="h-3.5 w-3.5" />
          Shortcuts
        </button>
      </div>
      <Sheet open={helpOpen} onOpenChange={setHelpOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-[520px]">
          <SheetHeader>
            <SheetTitle>Shortcuts</SheetTitle>
          </SheetHeader>
          <div className="mt-4 rounded-xl bg-primary/10 p-4 text-sm">
            <p className="font-medium text-foreground">Pro tip</p>
            <p className="text-muted-foreground">
              Add a space between searches to apply them together, e.g.{' '}
              <span className="font-medium text-foreground">date=this-month amount&gt;500</span>
            </p>
          </div>
          <div className="mt-5 space-y-6">
            {SEARCH_SECTIONS.map((sec) => (
              <section key={sec.title}>
                <h3 className="text-sm font-semibold text-foreground">{sec.title}</h3>
                <p className="mb-2 text-xs text-muted-foreground">{sec.description}</p>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {sec.examples.map(([syntax, desc]) => (
                    <li key={syntax}>
                      <button
                        type="button"
                        onClick={() => insert(syntax)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
                      >
                        <span className="text-muted-foreground">{desc}</span>
                        <code className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{syntax}</code>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
