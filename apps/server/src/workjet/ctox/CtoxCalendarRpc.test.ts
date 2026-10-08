import { assert, it } from "@effect/vitest";
import { WorkjetConnectionId, WorkjetDecisionHubConnectionError } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { makeCtoxCalendarRpc } from "./CtoxCalendarRpc.ts";
const target = { connectionId: WorkjetConnectionId.make("calendar-connection"), instanceId: "instance-a" };
const event = { id: "event", calendar_id: "calendar", kind: "synced", title: "Meeting",
  start_ms: 1, end_ms: 2, all_day: false, timezone: "UTC", revision: 1, account_id: "owned" };
function transport(answer: unknown) {
  const requests: unknown[] = [];
  const httpClient = HttpClient.make((request) => Effect.sync(() => {
    if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON.");
    requests.push(JSON.parse(new TextDecoder().decode(request.body.body)).params);
    return HttpClientResponse.fromWeb(request, Response.json({ jsonrpc: "2.0", result: { structuredContent: answer } }));
  }));
  return { httpClient, requests };
}
it.effect("pins the account calendar read to the authenticated selected instance", () => Effect.gen(function* () {
  const test = transport({ ok: true, events: [event], truncated: true, synced_at_ms: 3 });
  const scopes: unknown[] = [];
  const rpc = makeCtoxCalendarRpc({ ...test, connections: { resolveReadyTarget: (connection, instance) => Effect.sync(() => {
    scopes.push([connection, instance]); return { endpoint: "https://calendar.invalid/mcp/instance-a", token: "synthetic-test-token" };
  }) } });
  assert.equal((yield* rpc.events({ target, accountId: "owned", startMs: 0, endMs: 4 })).truncated, true);
  assert.deepEqual(scopes, [[target.connectionId, target.instanceId]]);
  assert.deepEqual(test.requests, [{ name: "business_os.calendar_events", arguments: { account_id: "owned", start_ms: 0, end_ms: 4 } }]);
}));
it.effect("rejects another account's receipt and never calls a mismatched instance", () => Effect.gen(function* () {
  const test = transport({ ok: true, events: [{ ...event, account_id: "foreign" }], truncated: false, synced_at_ms: 3 });
  const credentials = { endpoint: "https://calendar.invalid/mcp/instance-a", token: "synthetic-test-token" };
  const rpc = makeCtoxCalendarRpc({ ...test, connections: { resolveReadyTarget: () => Effect.succeed(credentials) } });
  assert.equal((yield* Effect.flip(rpc.events({ target, accountId: "owned", startMs: 0, endMs: 4 }))).reason, "calendar-unavailable");
  const disconnected = makeCtoxCalendarRpc({ ...test, connections: { resolveReadyTarget: () => Effect.fail(new WorkjetDecisionHubConnectionError({ reason: "connection-instance-mismatch" })) } });
  assert.equal((yield* Effect.flip(disconnected.accounts(target))).reason, "connection-unavailable");
  assert.equal(test.requests.length, 1);
}));
