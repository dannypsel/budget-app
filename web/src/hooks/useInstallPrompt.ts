import { useCallback, useEffect, useState } from "react";

/** Minimal typing for the beforeinstallprompt event (not in lib.dom yet). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export interface InstallPrompt {
  /** True while a beforeinstallprompt event is stashed and awaiting use. */
  canInstall: boolean;
  /** Show the browser's install prompt. No-op when `canInstall` is false. */
  promptInstall: () => Promise<void>;
  /** iOS Safari never fires beforeinstallprompt — use manual instructions. */
  isIOS: boolean;
  /** True when already launched from the home screen. */
  isStandalone: boolean;
}

/**
 * Wraps the PWA install flow. `canInstall` is true only while a
 * `beforeinstallprompt` event is stashed — on iOS it stays false forever, so
 * `isIOS && !canInstall` means "show the Add to Home Screen instructions".
 */
export function useInstallPrompt(): InstallPrompt {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent;
    setIsIOS(
      /iphone|ipad|ipod/i.test(ua) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    );
    setIsStandalone(
      window.matchMedia("(display-mode: standalone)").matches ||
        (navigator as { standalone?: boolean }).standalone === true,
    );

    const onBeforeInstallPrompt = (e: Event) => {
      // Hold the event so we can trigger it from our own UI later.
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () =>
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    setDeferredPrompt(null);
  }, [deferredPrompt]);

  return {
    canInstall: deferredPrompt !== null,
    promptInstall,
    isIOS,
    isStandalone,
  };
}
