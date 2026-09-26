// Simplifi-style sidebar navigation. Rendered twice by AppLayout: as a
// persistent fixed rail on desktop (md+), and inside a slide-over Sheet on
// mobile opened from the TopAppBar hamburger.

import { Link, useLocation } from "react-router-dom";
import { isNavActive, sidebarNav } from "@/lib/nav";
import { cn } from "@/lib/utils";

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();

  return (
    <nav aria-label="Primary" className="flex h-full flex-col gap-1 overflow-y-auto p-3">
      <div className="px-3 pb-4 pt-2">
        <span className="font-serif text-2xl font-semibold tracking-normal text-primary">
          PocketLens
        </span>
      </div>
      {sidebarNav.map((item) => {
        const active = isNavActive(pathname, item.to);
        const Icon = item.icon;
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-secondary-container font-semibold text-on-secondary-container"
                : "text-muted-foreground hover:bg-surface-container-high hover:text-foreground",
            )}
          >
            <Icon className="h-5 w-5 shrink-0" strokeWidth={active ? 2.25 : 2} aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
