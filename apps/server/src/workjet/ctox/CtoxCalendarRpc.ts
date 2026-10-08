import { WorkjetCalendarAccounts, WorkjetCalendarEvents, WorkjetCalendarError,
  type WorkjetCalendarEventsInput, type WorkjetCalendarTarget } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import type { DecisionHubConnectionRegistry } from "../decisionHub/DecisionHubConnectionRegistry.ts";
import { makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";

export function makeCtoxCalendarRpc(dependencies: {
  readonly connections: Pick<DecisionHubConnectionRegistry["Service"], "resolveReadyTarget">;
  readonly httpClient: HttpClient.HttpClient;
}) {
  const transport = makeCtoxMcpTransport(dependencies.httpClient);
  const call = Effect.fn("CtoxCalendarRpc.call")(function* (
    target: WorkjetCalendarTarget, tool: string, args: Readonly<Record<string, unknown>>,
  ) {
    // Credentials are selected on the server, pinned to the requested instance.
    const resolved = yield* dependencies.connections.resolveReadyTarget(target.connectionId, target.instanceId).pipe(
      Effect.mapError(() => new WorkjetCalendarError({ reason: "connection-unavailable" })),
    );
    const result = yield* transport.callTool(resolved, tool, args).pipe(
      Effect.mapError(() => new WorkjetCalendarError({ reason: "calendar-unavailable" })),
    );
    if (result.isError === true || result.structuredContent === undefined) return yield* new WorkjetCalendarError({ reason: "calendar-unavailable" });
    return result.structuredContent;
  });
  const invalid = () => new WorkjetCalendarError({ reason: "calendar-unavailable" });
  return {
    accounts: Effect.fn("CtoxCalendarRpc.accounts")(function* (target: WorkjetCalendarTarget) {
      const read = yield* call(target, "business_os.calendar_accounts", {});
      return yield* Schema.decodeUnknownEffect(WorkjetCalendarAccounts)(read).pipe(Effect.mapError(invalid));
    }),
    events: Effect.fn("CtoxCalendarRpc.events")(function* (input: WorkjetCalendarEventsInput) {
      const receipt = yield* call(input.target, "business_os.calendar_events", {
        account_id: input.accountId, start_ms: input.startMs, end_ms: input.endMs,
      });
      const read = yield* Schema.decodeUnknownEffect(WorkjetCalendarEvents)(receipt).pipe(Effect.mapError(invalid));
      if (read.events.some((event) => event.account_id !== input.accountId || event.kind !== "synced")) return yield* invalid();
      return read;
    }),
  };
}
