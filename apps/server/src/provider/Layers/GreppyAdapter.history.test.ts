// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderImportedMessage,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import type { AcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";
import { makeGreppyAdapter } from "./GreppyAdapter.ts";

const probe = vi.hoisted(() => ({
  capable: true,
  omitCapabilities: false,
  validAcknowledgement: true,
  promptGate: undefined as Deferred.Deferred<void> | undefined,
  promptEntered: undefined as Deferred.Deferred<void> | undefined,

  calls: [] as Array<{ method: string; payload?: unknown }>,
}));
vi.mock("../acp/GreppyAcpSupport.ts", () => ({
  makeGreppyAcpRuntime: () =>
    Effect.succeed({
      handleRequestPermission: () => Effect.void,
      start: () =>
        Effect.succeed({
          sessionId: "fixture-native-session",
          initializeResult: probe.omitCapabilities
            ? {}
            : {
                agentCapabilities: {
                  _meta: probe.capable ? { workjetImportHistory: { version: 1 } } : {},
                },
              },
        }),
      setSessionModel: () => Effect.void,
      getEvents: () => Stream.empty,
      drainEvents: Effect.void,
      cancel: Effect.void,
      request: (
        method: string,
        payload: { sessionId: string; messages: ReadonlyArray<ProviderImportedMessage> },
      ) =>
        Effect.sync(() => {
          probe.calls.push({ method, payload });
          return {
            acceptedMessageIds: probe.validAcknowledgement
              ? payload.messages.map(({ id }) => id)
              : [],
          };
        }),
      prompt: (payload: unknown) =>
        Effect.gen(function* () {
          probe.calls.push({ method: "session/prompt", payload });
          if (probe.promptEntered) yield* Deferred.succeed(probe.promptEntered, undefined);
          if (probe.promptGate) yield* Deferred.await(probe.promptGate);
          return { stopReason: "end_turn" as const };
        }),
    } as unknown as AcpSessionRuntime["Service"]),
}));

const imported: ReadonlyArray<ProviderImportedMessage> = [
  { id: MessageId.make("archive-user"), role: "user", text: "Original archived question" },
  { id: MessageId.make("archive-assistant"), role: "assistant", text: "Original archived answer" },
];
const withAdapter = <A, E>(
  run: (
    adapter: Effect.Success<ReturnType<typeof makeGreppyAdapter>>,
    threadId: ThreadId,
  ) => Effect.Effect<A, E>,
  dispatchPromptInBackground = false,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      probe.calls = [];
      const threadId = ThreadId.make("greppy-history-test");
      const adapter = yield* makeGreppyAdapter(
        {
          ...DEFAULT_SERVER_SETTINGS.providers.greppy,
          enabled: true,
          model: "claude-opus-5-5",
          endpoint: "http://127.0.0.1:18147",
        },
        {
          instanceId: ProviderInstanceId.make("greppy"),
          dispatchPromptInBackground,
          resolveSessionEnvironment: () => Effect.succeed({}),
        },
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("greppy"),
        cwd: "/fixture/project",
        runtimeMode: "full-access",
      });
      return yield* run(adapter, threadId).pipe(
        Effect.ensuring(adapter.stopSession(threadId).pipe(Effect.orDie)),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect(
  "acknowledges archive roles before prompting and synchronizes only changed snapshots",
  () => {
    probe.capable = true;
    probe.validAcknowledgement = true;
    return withAdapter((adapter, threadId) =>
      Effect.gen(function* () {
        yield* adapter.sendTurn({
          threadId,
          input: "First continuation",
          importedHistory: imported,
        });
        expect(probe.calls.map(({ method }) => method)).toEqual([
          "_workjet/import_history",
          "session/prompt",
        ]);
        expect(probe.calls[0]?.payload).toEqual({
          sessionId: "fixture-native-session",
          messages: imported,
        });
        expect(probe.calls[1]?.payload).toEqual({
          prompt: [{ type: "text", text: "First continuation" }],
        });
        yield* adapter.sendTurn({ threadId, input: "Native follow-up", importedHistory: imported });
        expect(
          probe.calls.filter(({ method }) => method === "_workjet/import_history"),
        ).toHaveLength(1);
        const appended = [
          ...imported,
          {
            id: MessageId.make("later-user"),
            role: "user" as const,
            text: "Later archived question",
          },
          {
            id: MessageId.make("later-assistant"),
            role: "assistant" as const,
            text: "Later archived answer",
          },
        ];
        yield* adapter.sendTurn({
          threadId,
          input: "Continue after reimport",
          importedHistory: appended,
        });
        expect(probe.calls.slice(-2).map(({ method }) => method)).toEqual([
          "_workjet/import_history",
          "session/prompt",
        ]);
        expect(probe.calls.at(-2)?.payload).toEqual({
          sessionId: "fixture-native-session",
          messages: appended,
        });
      }),
    );
  },
);

it.effect("does not prompt an agent that lacks imported-history support", () => {
  probe.capable = false;
  probe.validAcknowledgement = true;
  return withAdapter((adapter, threadId) =>
    Effect.gen(function* () {
      expect(
        Exit.isFailure(
          yield* adapter
            .sendTurn({ threadId, input: "Continue", importedHistory: imported })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(probe.calls).toEqual([]);
    }),
  );
});

it.effect(
  "does not prompt or cache incomplete acknowledgement and retries the same history",
  () => {
    probe.capable = true;
    probe.validAcknowledgement = false;
    return withAdapter((adapter, threadId) =>
      Effect.gen(function* () {
        expect(
          Exit.isFailure(
            yield* adapter
              .sendTurn({ threadId, input: "Continue", importedHistory: imported })
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(probe.calls.map(({ method }) => method)).toEqual(["_workjet/import_history"]);
        probe.validAcknowledgement = true;
        yield* adapter.sendTurn({ threadId, input: "Retry", importedHistory: imported });
        expect(probe.calls.map(({ method }) => method)).toEqual([
          "_workjet/import_history",
          "_workjet/import_history",
          "session/prompt",
        ]);
      }),
    );
  },
);

it.effect("accepts omitted capabilities at startup and refuses imported turns explicitly", () => {
  probe.omitCapabilities = true;
  return withAdapter((adapter, threadId) =>
    Effect.gen(function* () {
      expect(
        Exit.isFailure(
          yield* adapter
            .sendTurn({ threadId, input: "Continue", importedHistory: imported })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(probe.calls).toEqual([]);
    }),
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        probe.omitCapabilities = false;
      }),
    ),
  );
});

it.effect("acknowledges routed dispatch while the ACP prompt remains pending", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    probe.promptGate = gate;
    probe.promptEntered = entered;
    return yield* withAdapter((adapter, threadId) =>
      Effect.gen(function* () {
        const completed = yield* adapter.streamEvents.pipe(
          Stream.filter(event => event.type === "turn.completed"), Stream.take(1),
          Stream.runCollect, Effect.forkChild({ startImmediately: true }),
        );
        const receipt = yield* adapter.sendTurn({ threadId, input: "Read-only routed turn" });
        yield* Deferred.await(entered);
        expect(receipt.threadId).toBe(threadId);
        expect((yield* adapter.listSessions())[0]?.status).toBe("running");
        const overlap = yield* adapter.sendTurn({ threadId, input: "Overlapping turn" }).pipe(Effect.flip);
        expect(overlap.message).toContain("already answering");
        yield* Deferred.succeed(gate, undefined);
        const events = yield* Fiber.join(completed);
        expect(events[0]?.type).toBe("turn.completed");
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
      }), true);
  }).pipe(Effect.ensuring(Effect.sync(() => {
    probe.promptGate = undefined;
    probe.promptEntered = undefined;
  }))),
);
