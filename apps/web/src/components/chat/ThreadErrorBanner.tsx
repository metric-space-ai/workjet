import { memo, useState } from "react";
import { workjetUiLanguage } from "../../workjetProjectControl";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";

const RAW_ERROR_PATTERN =
  /\b[A-Z][A-Za-z]+(?:Error|Exception)\b|file:\/\/|\bat\s+\S+\s+\(|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/;

/**
 * Raw adapter errors (class names, file URLs, thread ids) never stand in the
 * chat as the message (#586): one plain sentence, the raw text under „Details“.
 */
export function threadErrorPresentation(error: string): {
  readonly summary: string;
  readonly details: string | null;
} {
  if (!RAW_ERROR_PATTERN.test(error)) return { summary: error, details: null };
  const en = workjetUiLanguage() === "en";
  const summary = /ProviderAdapter|spawn|ENOENT|process/i.test(error)
    ? en
      ? "The worker could not be started."
      : "Der Worker konnte nicht gestartet werden."
    : en
      ? "This step failed."
      : "Dieser Schritt ist fehlgeschlagen.";
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
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (!error) return null;
  const { summary, details } = threadErrorPresentation(error);
  const en = workjetUiLanguage() === "en";
  return (
    <div className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="error" controlAlignment="first-line">
        <CircleAlertIcon />
        <AlertDescription>
          <div className="line-clamp-3">{summary}</div>
          {details !== null ? (
            <>
              <button
                type="button"
                className="mt-1 text-xs font-medium"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((open) => !open)}
              >
                {detailsOpen ? (en ? "Hide details" : "Details ausblenden") : "Details"}
              </button>
              {detailsOpen ? (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                  {details}
                </pre>
              ) : null}
            </>
          ) : null}
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={en ? "Dismiss error" : "Fehler schließen"}
              onClick={onDismiss}
            >
              <XIcon className="text-destructive" />
            </Button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
