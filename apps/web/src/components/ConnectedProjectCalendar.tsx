import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import type { WorkjetCalendarEvents, WorkjetCalendarTarget } from "@workjet/contracts";
import { useActiveWorkjetScope } from "../activeWorkjetScope";
import { useSessionCalendar } from "../calendar/useSessionCalendar";
import {
  addDays,
  monthGrid,
  zonedReading,
  localTimeZone,
  type DateKey,
} from "../calendar/calendarDates";
import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { ctoxConnectionMatchesSelectedInstance } from "../workjetCtoxConnections";
import { ProjectCalendar, type AccountCalendarState } from "./ProjectCalendar";

type Page = { readonly accountId: string; readonly read: WorkjetCalendarEvents | null };
export function ConnectedProjectCalendar(
  props: Pick<ComponentProps<typeof ProjectCalendar>, "projects">,
) {
  const { selectedInstanceId } = useActiveWorkjetScope();
  const { snapshot, refresh } = useSessionCalendar(selectedInstanceId);
  const environment = usePrimaryEnvironment();
  const connections = useEnvironmentQuery(
    environment === null
      ? null
      : serverEnvironment.workjetDecisionHubConnections({
          environmentId: environment.environmentId,
          input: {},
        }),
  );
  const matches = (connections.data?.connections ?? []).filter(
    (entry) =>
      entry.status === "ready" &&
      selectedInstanceId !== null &&
      ctoxConnectionMatchesSelectedInstance(entry, selectedInstanceId),
  );
  const connection =
    matches.length === 1
      ? matches[0]
      : matches.find(
          (entry) =>
            entry.connectionId === `ctox-dev:${selectedInstanceId?.replace(/^managed:/, "")}`,
        );
  const target = useMemo<WorkjetCalendarTarget | null>(
    () =>
      connection === undefined
        ? null
        : { connectionId: connection.connectionId, instanceId: connection.instanceId },
    [connection?.connectionId, connection?.instanceId],
  );
  const accounts = useEnvironmentQuery(
    environment === null || target === null
      ? null
      : serverEnvironment.calendarAccounts({
          environmentId: environment.environmentId,
          input: target,
        }),
  );
  const readEvents = useAtomCommand(serverEnvironment.calendarEvents, { reportFailure: false });
  const [range, setRange] = useState(() => {
    const grid = monthGrid(zonedReading(Date.now(), localTimeZone()).date);
    return { from: grid[0]!, to: grid[41]! };
  });
  const rangeChanged = useCallback(
    (from: DateKey, to: DateKey) =>
      setRange((old) => (old.from === from && old.to === to ? old : { from, to })),
    [],
  );
  const [generation, setGeneration] = useState(0);
  const [pages, setPages] = useState<{ key: string; values: readonly Page[] }>({
    key: "",
    values: [],
  });
  const key = `${environment?.environmentId}:${target?.connectionId}:${target?.instanceId}:${range.from}:${range.to}:${generation}`;
  useEffect(() => {
    if (environment === null || target === null || accounts.data === null) return;
    const authorizedAccounts = accounts.data.accounts;
    let disposed = false;
    setPages({ key, values: [] });
    // One provider request at a time. Leaving the calendar or switching its
    // instance fences late results and prevents further account reads.
    void (async () => {
      for (const account of authorizedAccounts) {
        if (disposed) return;
        if (!account.supported) continue;
        const result = await readEvents({
          environmentId: environment.environmentId,
          input: {
            target,
            accountId: account.id,
            startMs: Date.parse(`${addDays(range.from, -1)}T00:00:00Z`),
            endMs: Date.parse(`${addDays(range.to, 2)}T00:00:00Z`),
          },
        });
        if (disposed) return;
        const page = {
          accountId: account.id,
          read: result._tag === "Success" ? result.value : null,
        };
        setPages((old) => ({ key, values: [...(old.key === key ? old.values : []), page] }));
      }
    })();
    return () => {
      disposed = true;
    };
  }, [
    environment?.environmentId,
    target,
    accounts.data,
    range.from,
    range.to,
    generation,
    readEvents,
    key,
  ]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        accounts.refresh();
        setGeneration((old) => old + 1);
      }
    }, 300_000);
    return () => window.clearInterval(timer);
  }, [accounts.refresh]);
  const current = pages.key === key ? pages.values : [];
  const calendarStates: readonly AccountCalendarState[] = (accounts.data?.accounts ?? []).map(
    (account) => {
      const page = current.find((item) => item.accountId === account.id);
      return {
        id: account.calendar_id,
        label: account.label,
        status: !account.supported
          ? "unsupported"
          : page === undefined
            ? "loading"
            : page.read === null
              ? "unavailable"
              : "ready",
        truncated: page?.read?.truncated ?? false,
        syncedAtMs: page?.read?.synced_at_ms ?? null,
      };
    },
  );
  return (
    <ProjectCalendar
      key={`${environment?.environmentId}:${target?.connectionId}:${selectedInstanceId}`}
      {...props}
      sessions={snapshot.sessions}
      sessionsStatus={selectedInstanceId === null ? "unavailable" : snapshot.status}
      onRefreshSessions={refresh}
      onWindowChanged={rangeChanged}
      accountEvents={current.flatMap((page) => page.read?.events ?? [])}
      accountCalendars={calendarStates}
      accountsUnavailable={target === null || accounts.error !== null}
      accountsLoading={accounts.isPending}
      accountsTruncated={accounts.data?.truncated ?? false}
      onRefreshAccounts={() => {
        accounts.refresh();
        setGeneration((old) => old + 1);
      }}
    />
  );
}
