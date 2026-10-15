import { EyeIcon, EyeOffIcon } from "lucide-react";
import type { ReactNode } from "react";

import { privacyModeLabels, togglePrivacyMode, usePrivacyMode } from "../../privacyMode";

/** Content that privacy mode blurs in overviews (#526). */
export function Sensitive({ children }: { readonly children: ReactNode }) {
  return <span data-sensitive="">{children}</span>;
}

function uiLanguage(): "de" | "en" {
  const lang = typeof document === "undefined" ? "de" : document.documentElement.lang;
  return lang.toLowerCase().startsWith("en") ? "en" : "de";
}

/** Eye icon in the title bar. */
export function PrivacyModeToggle({ mac }: { readonly mac: boolean }) {
  const on = usePrivacyMode();
  const labels = privacyModeLabels(uiLanguage());
  const label = `${on ? labels.disable : labels.enable} (${mac ? "⌘⇧B" : "Ctrl+Shift+B"})`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      className="no-drag flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring aria-pressed:text-foreground"
      data-workjet-header-privacy=""
      onClick={togglePrivacyMode}
    >
      {on ? (
        <EyeOffIcon className="size-4" aria-hidden />
      ) : (
        <EyeIcon className="size-4" aria-hidden />
      )}
      <span>{uiLanguage() === "en" ? "Private" : "Privat"}</span>
    </button>
  );
}
