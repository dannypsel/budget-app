import { useState } from "react";
import { ChevronRight, Download, Share } from "lucide-react";

import { useInstallPrompt } from "@/hooks/useInstallPrompt";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card";

export interface InstallAppRowProps {
  /** Extra classes merged onto the row button (e.g. border separators). */
  className?: string;
}

/**
 * Settings-style "Install app" row, ready to drop into Settings > General.
 * Matches the existing settings row look: 40px icon well + label + chevron.
 *
 * Behavior:
 * - Browsers with a stashed install prompt (Chrome/Edge/Samsung): tapping the
 *   row fires the browser's install prompt directly.
 * - iOS Safari (no prompt event): opens an inline dialog with the
 *   Share -> "Add to Home Screen" steps.
 * - Browsers with no install support at all: opens the dialog with a note
 *   explaining installation isn't available there.
 */
export function InstallAppRow({ className }: InstallAppRowProps) {
  const { canInstall, promptInstall, isIOS, isStandalone } = useInstallPrompt();
  const [instructionsOpen, setInstructionsOpen] = useState(false);

  const handleClick = () => {
    if (canInstall) {
      void promptInstall();
    } else {
      setInstructionsOpen(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        aria-label={isStandalone ? "App already installed" : "Install app"}
        className={cn(
          "group flex w-full items-center gap-4 rounded-lg p-4 text-left transition-colors motion-reduce:transition-none",
          "hover:bg-surface-variant",
          focusRing,
          className,
        )}
      >
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container text-primary transition-colors group-hover:bg-primary-container group-hover:text-on-primary-container motion-reduce:transition-none"
        >
          <Download className="h-5 w-5" />
        </span>
        <span className="flex-1 text-lg leading-7 text-foreground">
          Install app
          {isStandalone && (
            <span className="ml-2 text-xs font-semibold text-muted-foreground">
              Installed
            </span>
          )}
        </span>
        <ChevronRight aria-hidden className="h-5 w-5 shrink-0 text-outline" />
      </button>

      <Dialog open={instructionsOpen} onOpenChange={setInstructionsOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Install PocketLens</DialogTitle>
            <DialogDescription>
              {isIOS
                ? "Add PocketLens to your Home Screen for full-screen, one-tap access."
                : "Your browser doesn't support installing apps — try Chrome, Edge, or Safari."}
            </DialogDescription>
          </DialogHeader>
          {isIOS && (
            <ol className="flex flex-col gap-3 text-sm text-foreground">
              <li className="flex items-center gap-3">
                <Share aria-hidden className="h-4 w-4 shrink-0 text-primary" />
                Tap the <span className="font-medium">Share</span> button in the
                toolbar
              </li>
              <li className="flex items-center gap-3">
                <Download aria-hidden className="h-4 w-4 shrink-0 text-primary" />
                Choose <span className="font-medium">“Add to Home Screen”</span>
              </li>
              <li className="flex items-center gap-3">
                <ChevronRight
                  aria-hidden
                  className="h-4 w-4 shrink-0 text-primary"
                />
                Tap <span className="font-medium">Add</span> to confirm
              </li>
            </ol>
          )}
          <Button onClick={() => setInstructionsOpen(false)}>Done</Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
