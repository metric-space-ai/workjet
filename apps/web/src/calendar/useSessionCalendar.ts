import { useEffect, useRef, useState } from "react";
import { createSessionCalendarReader, type SessionCalendarSnapshot } from "./sessionCalendar";

const EMPTY: SessionCalendarSnapshot = { status: "loading", sessions: [] };
export function useSessionCalendar(instanceId: string | null) {
  const [value, setValue] = useState({ instanceId, snapshot: EMPTY });
  const reader = useRef<ReturnType<typeof createSessionCalendarReader> | null>(null);
  useEffect(() => {
    if (instanceId === null) { reader.current = null; return; }
    const current = createSessionCalendarReader(instanceId, (snapshot) => setValue({ instanceId, snapshot }));
    reader.current = current;
    void current.refresh();
    const unsubscribe = window.desktopBridge?.ctox?.onSessionTransferEvent?.((event) => {
      if (event.instanceId === instanceId) void current.refresh();
    });
    return () => { current.dispose(); unsubscribe?.(); if (reader.current === current) reader.current = null; };
  }, [instanceId]);
  return {
    snapshot: value.instanceId === instanceId ? value.snapshot : EMPTY,
    refresh: () => { void reader.current?.refresh(); },
  };
}
