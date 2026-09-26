import { useState } from "react";
import { Download, Share, X } from "lucide-react";

import { useInstallPrompt } from "@/hooks/useInstallPrompt";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DISMISS_KEY = "pwa-install-dismissed";

/**
 * Slim, dismissible install nudge rendered just above the page content.
 * Shown only in a regular browser tab (`!isStandalone`) until dismissed.
 * - Browsers with an install prompt: "Install PocketLens for quick access" + button.
 * - iOS Safari (no prompt event): inline Share -> "Add to Home Screen" steps.
 * - Otherwise: nothing (no dead banner).
 */
export function InstallBanner({ className }: { className?: string }) {
  const { canInstall, promptInstall, isIOS, isStandalone } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === "1",
  );

  if (isStandalone || dismissed) return null;
  if (!canInstall && !isIOS) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  return (
    <div
      role="region"
      aria-label="Install PocketLens"
      className={cn(
        "flex items-center gap-3 border-b border-border/60 bg-card px-4 py-2.5",
        className,
      )}
    >
      {canInstall ? (
        <>
          <Download aria-hidden className="h-4 w-4 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 truncate text-sm text-foreground">
            Install PocketLens for quick access
          </p>
          <Button size="sm" className="h-7 rounded-full" onClick={() => void promptInstall()}>
            Install
          </Button>
        </>
      ) : (
        <>
          <Share aria-hidden className="h-4 w-4 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 text-sm text-foreground">
            To install, tap <span className="font-medium">Share</span> then{" "}
            <span className="font-medium">“Add to Home Screen”</span>
          </p>
        </>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install banner"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-variant"
      >
        <X aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}
