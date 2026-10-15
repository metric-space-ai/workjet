import { type ServerProvider } from "@workjet/contracts";
import { memo } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatProviderDriverKindLabel } from "../../providerModels";
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

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  onDismiss,
  status,
}: {
  onDismiss: () => void;
  status: ServerProvider | null;
}) {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isMissingHarness = isProviderHarnessMissing(status);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const title = isMissingHarness
    ? `Harness fehlt: ${providerName}`
    : isUnauthenticated
      ? `${providerName} nicht angemeldet`
      : `${providerName}-Zustand`;
  // Rohtext des Anbieters (englisch, HTTP-Status) steht nur hinter „Details“.
  const raw = status.message?.trim() || null;
  const rawIsPlain = raw !== null && isComposerPlainLine(raw);
  const message = isMissingHarness
    ? "Auf diesem Rechner nicht installiert. Harness wechseln oder installieren."
    : isUnauthenticated
      ? "Per CLI neu anmelden"
      : rawIsPlain
        ? raw
        : status.status === "error"
          ? `${providerName} nicht verfügbar`
          : `${providerName} eingeschränkt verfügbar`;
  const details =
    !isMissingHarness && !isUnauthenticated && raw !== null && !rawIsPlain ? raw : null;

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <div
        className={cn(
          "alert-glass relative inline-flex items-center gap-3 rounded-xl border py-3 ps-3.5 pe-10 text-card-foreground text-sm",
          status.status === "warning"
            ? "border-warning/32 [&_svg]:text-warning"
            : "border-destructive/32 text-destructive-foreground [&_svg]:text-destructive",
        )}
        data-variant={status.status === "warning" ? "warning" : "error"}
        role="alert"
      >
        <InfoIcon className="size-4 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="font-medium">{title}</div>
          <div className="line-clamp-3 text-muted-foreground">{message}</div>
          {details ? (
            <details className="text-muted-foreground text-xs">
              <summary className="w-fit cursor-pointer select-none">Details</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono">
                {details}
              </pre>
            </details>
          ) : null}
        </div>
        <button
          type="button"
          aria-label={`${providerName}-${status.status === "warning" ? "Warnung" : "Fehler"} schließen`}
          className="absolute top-2 right-2 inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onDismiss}
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      </div>
    </div>
  );
});
