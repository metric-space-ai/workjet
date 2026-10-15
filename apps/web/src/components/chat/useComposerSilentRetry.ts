import { useEffect, useRef, useState } from "react";
import { COMPOSER_SILENT_RETRY_MS, COMPOSER_UNREACHABLE_NOTICE_MS } from "./composerErrorLineLogic";

/**
 * Still wiederholen statt melden: solange `unreachable` gilt, ruft der Hook
 * `retry` alle 15 s auf und liefert, wie lange der Ausfall schon dauert.
 * Erst ab 2 min darf der Composer eine Zeile zeigen (siehe `composerErrorLine`).
 */
export function useComposerSilentRetry(
  unreachable: boolean,
  retry: (() => void) | null,
): number | null {
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const retryRef = useRef(retry);
  retryRef.current = retry;

  useEffect(() => {
    if (!unreachable) {
      setSince(null);
      return;
    }
    const startedAt = Date.now();
    setSince((current) => current ?? startedAt);
    setNow(startedAt);
    const interval = window.setInterval(() => {
      setNow(Date.now());
      retryRef.current?.();
    }, COMPOSER_SILENT_RETRY_MS);
    // Der Schwellwert soll pünktlich greifen, nicht erst beim nächsten Intervall.
    const notice = window.setTimeout(() => setNow(Date.now()), COMPOSER_UNREACHABLE_NOTICE_MS + 50);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(notice);
    };
  }, [unreachable]);

  return unreachable && since !== null ? Math.max(0, now - since) : null;
}
