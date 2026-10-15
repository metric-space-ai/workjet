import { useEffect, useState } from "react";

import {
  THREAD_SYNC_NOTICE_MS,
  THREAD_SYNC_RETRY_LABEL,
  THREAD_SYNC_SLOW_LINE,
  type ThreadSyncPhase,
} from "../../threadSync";
import { Button } from "../ui/button";

/**
 * Laden und Abgleichen der Nachrichten bleiben still. Dauert es länger als
 * 10 s, steht eine deutsche Statuszeile mit genau einer Aktion da
 * (UI-Vertrag §1.3: ein Laden endet immer).
 */
export function ThreadSyncStatusLine(props: {
  readonly phase: ThreadSyncPhase;
  readonly onRetry: () => void;
  /** Nur für Tests: die Zeile sofort zeigen. */
  readonly initiallySlow?: boolean;
}) {
  const [slow, setSlow] = useState(props.initiallySlow === true);

  useEffect(() => {
    if (props.initiallySlow) return;
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), THREAD_SYNC_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [props.phase, props.initiallySlow]);

  if (!slow) return null;

  return (
    <div
      role="status"
      data-thread-sync-slow="true"
      className="mb-2 flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground"
    >
      <span className="min-w-0 truncate">{THREAD_SYNC_SLOW_LINE}</span>
      <Button type="button" size="xs" variant="outline" onClick={props.onRetry}>
        {THREAD_SYNC_RETRY_LABEL}
      </Button>
    </div>
  );
}
