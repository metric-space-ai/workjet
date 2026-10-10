// @effect-diagnostics nodeBuiltinImport:off -- Exercise real owned child/Unix socket lifecycle using an explicitly isolated protocol fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, it } from "@effect/vitest";
import {
  acquireNativeSupervisorSourceTransport,
  openNativeSupervisorSourceTransport,
  NativeSupervisorSourceTransportError,
} from "./NativeSupervisorSourceTransport.ts";

const executable = NodeURL.fileURLToPath(new URL("./testFixtures/nativeSupervisorSource.mjs", import.meta.url));
const Reply = Schema.Struct({
  fixture: Schema.Literal(true),
  action: Schema.String,
  args: Schema.Array(Schema.String),
});
const decodeReply = Schema.decodeUnknownEffect(Reply);
const Recorded = Schema.fromJsonString(Schema.Struct({ requestId: Schema.String, action: Schema.String }));
const decodeRecorded = Schema.decodeUnknownEffect(Recorded);
const fixture = Effect.fn("NativeSupervisorSourceTransport.fixture")(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(process.env.TMPDIR || NodeOS.tmpdir(), "supervisor-source-"))),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
  );
  return {
    executable, targetId: "original-encrypted-target",
    originalNativeRoot: NodePath.join(directory, "original-native"),
    ipcDirectory: NodePath.join(directory, "private-ipc"),
  };
});
const readRequests = Effect.fn("NativeSupervisorSourceTransport.readFixtureRequests")(function* (directory: string) {
  const jsonl = yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(directory, "requests.jsonl"), "utf8"));
  return yield* Effect.forEach(jsonl.trim().split("\n"), decodeRecorded);
});

it.effect("uses the original enrollment argv and emitted endpoint, with one sequential IPC channel", () =>
  Effect.gen(function* () {
    const enrollment = yield* fixture();
    const transport = yield* acquireNativeSupervisorSourceTransport(enrollment);
    expect(transport.executionReady).toBe(false);
    const replies = yield* Effect.promise(() => Promise.all([
      transport.request("poll-1", { version: 1, action: "poll" }),
      transport.request("status-2", { version: 1, action: "status", offer_id: "retained" }),
    ]));
    const first = yield* decodeReply(replies[0]);
    const second = yield* decodeReply(replies[1]);
    expect(first.args).toEqual(["sync", "supervisor-source", enrollment.targetId, enrollment.ipcDirectory, "--root", enrollment.originalNativeRoot]);
    expect(first.action).toBe("poll");
    expect(second.action).toBe("status");
    expect(transport.endpoint).toBe(NodePath.join(enrollment.ipcDirectory, "fixture-authority.sock"));
    expect(yield* readRequests(enrollment.ipcDirectory)).toEqual([
      { requestId: "poll-1", action: "poll" }, { requestId: "status-2", action: "status" },
    ]);
    // The actual owned process drain is separate from any SDK/controller stop claim.
    expect(yield* Effect.promise(() => transport.close())).toEqual({ exitCode: 0, signal: null });
    expect(yield* Effect.promise(() => transport.close())).toEqual({ exitCode: 0, signal: null });
  }).pipe(Effect.scoped),
);

it.effect.each(["eof", "wrong-id", "oversized-response", "unavailable"])(
  "retains outcome-unknown after %s, without replay, rebind or a cancellation receipt",
  (action) => Effect.gen(function* () {
    const enrollment = yield* fixture();
    const transport = yield* acquireNativeSupervisorSourceTransport(enrollment);
    const error = yield* Effect.flip(Effect.tryPromise({
      try: () => transport.request("retained-original-request", { version: 1, action }),
      catch: (cause) => cause,
    }));
    expect(error).toBeInstanceOf(NativeSupervisorSourceTransportError);
    expect(error).toMatchObject({ reason: "outcome-unknown", requestId: "retained-original-request" });
    const next = yield* Effect.flip(Effect.tryPromise({
      try: () => transport.request("new-request", { version: 1, action: "poll" }),
      catch: (cause) => cause,
    }));
    expect(next).toMatchObject({ reason: "transport-lost" });
    expect(yield* readRequests(enrollment.ipcDirectory)).toEqual([
      { requestId: "retained-original-request", action },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("rejects invalid IDs and oversized SDK envelopes before any native operation", () =>
  Effect.gen(function* () {
    const enrollment = yield* fixture();
    const transport = yield* acquireNativeSupervisorSourceTransport(enrollment);
    for (const [requestId, operation] of [
      ["invalid request", { version: 1, action: "poll" }],
      ["oversized", { version: 1, action: "model_invoke", body_json: "x".repeat(262_144) }],
    ] as const) {
      const error = yield* Effect.flip(Effect.tryPromise({
        try: () => transport.request(requestId, operation),
        catch: (cause) => cause,
      }));
      expect(error).toMatchObject({ reason: "invalid-input" });
    }
    yield* Effect.promise(() => transport.request("only-native-operation", { version: 1, action: "poll" }));
    expect(yield* readRequests(enrollment.ipcDirectory)).toEqual([
      { requestId: "only-native-operation", action: "poll" },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("rejects startup that claims execution readiness instead of native transport-only readiness", () =>
  Effect.gen(function* () {
    const enrollment = yield* fixture();
    const result = yield* Effect.flip(Effect.tryPromise({
      try: () => openNativeSupervisorSourceTransport({ ...enrollment, targetId: "invalid-ready" }),
      catch: (cause) => cause,
    }));
    expect(result).toMatchObject({ reason: "startup-failed" });
  }).pipe(Effect.scoped),
);
