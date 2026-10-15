import { type ServerProvider } from "@workjet/contracts";
import { memo } from "react";
import { CircleAlertIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isComposerPlainLine } from "./composerErrorLineLogic";

export function getProviderStatusBannerKey(status: ServerProvider | null): string | null {
  return !status || status.status === "ready" || status.status === "disabled"
    ? null
    : [status.instanceId, status.status, status.auth.status, status.message ?? ""].join("\u0000");
}

export function shouldShowProviderStatusBanner(
  status: ServerProvider | null,
  dismissedBannerKey: string | null,
): boolean {
  const bannerKey = getProviderStatusBannerKey(status);
  return bannerKey !== null && bannerKey !== dismissedBannerKey;
}

/** The harness binary is absent on this computer (e.g. `codex` not on PATH). */
export function isProviderHarnessMissing(status: ServerProvider): boolean {
  return (
    status.status === "error" &&
    (!status.installed || /not installed|not on PATH|ENOENT/i.test(status.message ?? ""))
  );
}

/** Eine Zeile je Zustand (UI-Vertrag §1 Banner: Icon, eine Zeile, ein bis zwei Buttons). */
export function providerStatusBannerLine(status: ServerProvider): {
  readonly text: string;
  readonly actionLabel: string;
} {
  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  if (isProviderHarnessMissing(status)) {
    return { text: `${providerName} nicht installiert`, actionLabel: "Einrichten" };
  }
  if (status.status === "error" && status.auth.status === "unauthenticated") {
    return { text: `${providerName} nicht angemeldet`, actionLabel: "Anmelden" };
  }
  // Rohtext des Anbieters (englisch, HTTP-Status) bleibt draußen.
  const raw = status.message?.trim() || null;
  if (raw !== null && isComposerPlainLine(raw)) {
    return { text: raw, actionLabel: "Einrichten" };
  }
  return {
    text:
      status.status === "error"
        ? `${providerName} nicht verfügbar`
        : `${providerName} eingeschränkt verfügbar`,
    actionLabel: "Einrichten",
  };
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  onDismiss,
  onAction,
  status,
}: {
  onDismiss: () => void;
  /** Führt in den Harness-Bereich der App (Einrichten bzw. Anmelden). */
  onAction: () => void;
  status: ServerProvider | null;
}) {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const line = providerStatusBannerLine(status);
  const warning = status.status === "warning";
  const Icon = warning ? TriangleAlertIcon : CircleAlertIcon;
  const dismissLabel = `${providerName}-${warning ? "Warnung" : "Fehler"} schließen`;

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <div
        className={cn(
          "alert-glass flex min-w-0 items-center gap-2 rounded-xl border py-1.5 ps-3 pe-1.5 text-[13.5px] text-card-foreground",
          warning
            ? "border-warning/32 [&>svg]:text-warning"
            : "border-destructive/32 [&>svg]:text-destructive",
        )}
        data-variant={warning ? "warning" : "error"}
        role="alert"
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate font-medium">{line.text}</span>
        <Button type="button" size="xs" onClick={onAction}>
          {line.actionLabel}
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={dismissLabel}
                onClick={onDismiss}
              />
            }
          >
            <XIcon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Schließen</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
