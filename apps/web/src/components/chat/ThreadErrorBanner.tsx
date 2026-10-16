import { memo } from "react";
import { isComposerPlainLine } from "./composerErrorLineLogic";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { usePlanStepRetry } from "../../lib/workjetPlanStepRetry";

const START_FAILURE_PATTERN = /ProviderAdapter|spawn|ENOENT|process/i;

/**
 * Adapter errors never stand in the chat as the message (#586, UI-Vertrag §2):
 * a short German line of at most 12 words; the raw text stays in `details`
 * for logs only and is never rendered.
 */
export function threadErrorPresentation(error: string): {
  readonly summary: string;
  readonly details: string | null;
} {
  const plain = error.trim().replace(/[.!]+$/, "");
  if (isComposerPlainLine(plain)) return { summary: plain, details: null };
  const summary = START_FAILURE_PATTERN.test(error)
    ? "Worker nicht gestartet"
    : "Schritt fehlgeschlagen";
  return { summary, details: error };
}

export function getThreadErrorBannerKey(threadKey: string, error: string | null): string | null {
  return error === null ? null : `${threadKey}\u0000${error}`;
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  error: string | null,
  isDismissed: boolean,
): boolean {
  return getThreadErrorBannerKey(threadKey, error) !== null && !isDismissed;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes between threads). Mirrors the branch-mismatch banner: a dismissal
// is remembered per thread key plus message, so navigating away to a thread
// with no error cannot resurrect the banner, while a different error message
// on the same thread still appears.
const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey !== null) {
    sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  }
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedThreadErrorBannerKeys.has(bannerKey);
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  onRetry,
  planStep,
}: {
  error: string | null;
  onDismiss?: () => void;
  /** Die eine Aktion des Banners; ohne Wiederholungsweg bleibt nur Schließen. */
  onRetry?: () => void;
  /**
   * Fehlgeschlagener CTOX-Planschritt (Audit B #24): „Erneut versuchen“ sendet
   * `ctox.plan.step.retry`; kennt die Instanz den Befehl nicht, fehlt der Knopf.
   */
  planStep?: { readonly instanceId: string; readonly stepId: string } | null;
}) {
  const retryPlanStep = usePlanStepRetry(planStep);
  const retry = onRetry ?? retryPlanStep;
  if (!error) return null;
  const { summary } = threadErrorPresentation(error);
  return (
    <div className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="error" controlAlignment="first-line">
        <CircleAlertIcon />
        <AlertDescription>
          <div className="truncate">{summary}</div>
        </AlertDescription>
        {retry || onDismiss ? (
          <AlertAction>
            {retry ? (
              <Button size="xs" variant="outline" onClick={retry}>
                Erneut versuchen
              </Button>
            ) : null}
            {onDismiss ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Fehler schließen"
                title="Fehler schließen"
                onClick={onDismiss}
              >
                <XIcon className="text-destructive" />
              </Button>
            ) : null}
          </AlertAction>
        ) : null}
      </Alert>
    </div>
  );
});
