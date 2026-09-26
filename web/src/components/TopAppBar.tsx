import { useState } from "react";
import { LogOut, Menu, Settings as SettingsIcon, User } from "lucide-react";
import { Link } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { SidebarContent } from "@/components/Sidebar";
import { useAuth } from "@/lib/auth";
import NotificationBell from "./NotificationBell";

// The top bar no longer carries the primary nav — that moved to the sidebar.
// Mobile gets a hamburger (top-left) opening the sidebar as a slide-over;
// desktop keeps the persistent rail. Brand lives in the sidebar now.

export default function TopAppBar() {
  const { user, signOut } = useAuth();
  const initial = user?.email?.charAt(0).toUpperCase();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-40 w-full border-b border-border/60 bg-background/80 backdrop-blur-sm">
        {/* h-[72px] is pinned — AllTransactionsPage's sticky bar offsets by it (top-[72px]) */}
        <div className="page-container flex h-[72px] items-center justify-between">
          <div className="flex items-center gap-1">
            {/* Hamburger: mobile slide-over sidebar */}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation menu"
              className="flex h-10 w-10 items-center justify-center rounded-full text-foreground transition-colors hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
            >
              <Menu className="h-5 w-5" aria-hidden />
            </button>
            {/* Profile affordance: opens account menu (identity + Settings + Sign out). */}
            <DropdownMenu>
              <DropdownMenuTrigger
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-variant text-primary transition-colors hover:bg-surface-container-high focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Account menu"
              >
                {initial ? (
                  <span className="text-sm font-semibold">{initial}</span>
                ) : (
                  <User className="h-5 w-5" />
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                {user?.email && (
                  <>
                    <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
                      {user.email}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem asChild>
                  <Link to="/settings" className="w-full cursor-pointer">
                    <SettingsIcon className="mr-2 h-4 w-4" />
                    Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer text-destructive focus:text-destructive"
                  onSelect={() => void signOut()}
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex items-center gap-1">
            <NotificationBell />
          </div>
        </div>
      </header>

      {/* Mobile slide-over sidebar */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="w-72 p-0 sm:max-w-xs" aria-label="Navigation">
          <SidebarContent onNavigate={() => setDrawerOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
