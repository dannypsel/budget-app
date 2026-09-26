import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import TopAppBar from "@/components/TopAppBar";
import { SidebarContent } from "@/components/Sidebar";
import { InstallBanner } from "@/components/InstallBanner";
import { PageTransition } from "@/lib/motion";
import { sidebarNav } from "@/lib/nav";

// Drives document.title everywhere. Titles default to the nav labels in
// lib/nav.ts (the single nav config); entries below are only non-nav routes
// and overrides. Every page now owns its visible heading.
const pageMeta: Record<string, { title: string }> = {
  ...Object.fromEntries(sidebarNav.map((item) => [item.to, { title: item.label }])),
  "/import": { title: "Import CSV" },
  "/add-transaction": { title: "Transactions" },
  "/transfer": { title: "Transactions" },
  "/transfers/review": { title: "Transactions" },
  "/recurring": { title: "Recurring charges" },
  "/churning": { title: "Churning" },
};

export default function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  // Fresh signup (flag set by LoginPage): route straight to Settings with the
  // bank-connection wizard highlighted, instead of an empty dashboard.
  useEffect(() => {
    if (sessionStorage.getItem("fresh-signup")) {
      sessionStorage.removeItem("fresh-signup");
      navigate("/settings?setup=1", { replace: true });
    }
  }, [navigate]);

  const meta =
    pageMeta[location.pathname] ??
    (location.pathname.startsWith("/accounts/") ? { title: "Account" } : { title: "" });

  useEffect(() => {
    document.title = meta.title ? `${meta.title} — PocketLens` : "PocketLens";
  }, [meta.title]);

  return (
    <div className="min-h-svh bg-background">
      {/* Persistent sidebar rail on desktop; the TopAppBar hamburger opens the
          slide-over version on mobile. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border/60 bg-background md:block">
        <SidebarContent />
      </aside>

      <div className="md:pl-64">
        <TopAppBar />
        <InstallBanner />
        <main className="page-container flex-1 pb-10 pt-2">
          <PageTransition key={location.pathname}>
            <Outlet />
          </PageTransition>
        </main>
      </div>
    </div>
  );
}
