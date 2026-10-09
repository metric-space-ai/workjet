import { useCallback, useEffect, useState, type ComponentProps } from "react";
import type { WorkjetCalendarAccounts, WorkjetCalendarEvents } from "@workjet/contracts";
import { useActiveWorkjetScope } from "../activeWorkjetScope";
import { NativeAccountCalendar } from "../calendar/nativeAccountCalendar";
import { useSessionCalendar } from "../calendar/useSessionCalendar";
import { addDays, monthGrid, zonedReading, localTimeZone, type DateKey } from "../calendar/calendarDates";
import { ProjectCalendar, type AccountCalendarState } from "./ProjectCalendar";

type Page = { readonly accountId: string; readonly read: WorkjetCalendarEvents | null };
type Snapshot = { readonly key: string; readonly status: "loading" | "ready" | "unavailable";
  readonly accounts: WorkjetCalendarAccounts | null; readonly pages: readonly Page[] };
export function NativeProjectCalendar(props: Pick<ComponentProps<typeof ProjectCalendar>, "projects">) {
  const { selectedInstanceId } = useActiveWorkjetScope();
  const { snapshot: sessions, refresh: refreshSessions } = useSessionCalendar(selectedInstanceId);
  const [range, setRange] = useState(() => {
    const grid = monthGrid(zonedReading(Date.now(), localTimeZone()).date);
    return { from: grid[0]!, to: grid[41]! };
  });
  const rangeChanged = useCallback((from: DateKey, to: DateKey) =>
    setRange(old => old.from === from && old.to === to ? old : { from, to }), []);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration(old => old + 1), []);
  const key = `${selectedInstanceId}:${range.from}:${range.to}:${generation}`;
  const [snapshot, setSnapshot] = useState<Snapshot>({ key: "", status: "loading", accounts: null, pages: [] });
  useEffect(() => {
    if (selectedInstanceId === null) return;
    let disposed = false;
    const calendar = new NativeAccountCalendar(selectedInstanceId, () => !disposed);
    setSnapshot({ key, status: "loading", accounts: null, pages: [] });
    void (async () => {
      try {
        const accounts = await calendar.accounts();
        if (disposed) return;
        setSnapshot({ key, status: "ready", accounts, pages: [] });
        // Provider I/O is sequential and bounded; switching instances or leaving
        // the calendar prevents further requests and fences any late receipt.
        for (const account of accounts.accounts) {
          if (disposed) return;
          if (!account.supported) continue;
          let read: WorkjetCalendarEvents | null = null;
          try {
            read = await calendar.events(account.id,
              Date.parse(`${addDays(range.from, -1)}T00:00:00Z`),
              Date.parse(`${addDays(range.to, 2)}T00:00:00Z`));
          } catch { /* The affected account is unavailable; other accounts remain usable. */ }
          if (disposed) return;
          setSnapshot(old => old.key === key ? { ...old, pages: [...old.pages, { accountId: account.id, read }] } : old);
        }
      } catch {
        if (!disposed) setSnapshot({ key, status: "unavailable", accounts: null, pages: [] });
      }
    })();
    return () => { disposed = true; };
  }, [selectedInstanceId, range.from, range.to, generation, key]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 300_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const current = snapshot.key === key ? snapshot : null;
  const calendars: readonly AccountCalendarState[] = (current?.accounts?.accounts ?? []).map(account => {
    const page = current?.pages.find(item => item.accountId === account.id);
    return { id: account.calendar_id, label: account.label,
      status: !account.supported ? "unsupported" : page === undefined ? "loading" : page.read === null ? "unavailable" : "ready",
      truncated: page?.read?.truncated ?? false, syncedAtMs: page?.read?.synced_at_ms ?? null };
  });
  return <ProjectCalendar key={selectedInstanceId} {...props}
    sessions={sessions.sessions} sessionsStatus={selectedInstanceId === null ? "unavailable" : sessions.status}
    onRefreshSessions={refreshSessions} onWindowChanged={rangeChanged}
    accountEvents={current?.pages.flatMap(page => page.read?.events ?? []) ?? []}
    accountCalendars={calendars} accountsUnavailable={selectedInstanceId === null || current?.status === "unavailable"}
    accountsLoading={selectedInstanceId !== null && (current === null || current.status === "loading")}
    accountsTruncated={current?.accounts?.truncated ?? false} onRefreshAccounts={refresh} />;
}
