// @effect-diagnostics nodeBuiltinImport:off -- Owned child fixtures; no actual model, native authority or installed execution proof.
import * as NodeChildProcess from "node:child_process";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_MODEL } from "@workjet/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createNativeSupervisorSdkSourceJournal } from "./NativeSupervisorSdkSourceJournal.ts";

const offerId = "11111111-1111-4111-8111-111111111111";
const controllerId = "22222222-2222-4222-8222-222222222222";

it.effect(
  "sends ordered private original-controller callbacks and accepts only non-authoritative acknowledgements",
  () =>
    Effect.gen(function* () {
      const operations: Array<{ requestId: string; operation: Record<string, unknown> }> = [];
      const journal = createNativeSupervisorSdkSourceJournal({
        offerId,
        controllerId,
        transport: {
          request: async (requestId, operation) => {
            operations.push({ requestId, operation });
            const event = operation.sdk_observation as { sequence: number };
            return {
              version: 1,
              state: "sdk_observed",
              sequence: event.sequence,
              execution_ready: false,
            };
          },
        },
      });
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", 'process.stdin.once("data", () => process.exit(0));'],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          await closed;
        }),
      );
      journal.captureOwnedSdkChild(child);
      yield* Effect.promise(() =>
        journal.observeSdkMessage(
          {
            type: "system",
            subtype: "init",
            session_id: "original-session",
            uuid: "init-observation",
            model: DEFAULT_MODEL,
          } as unknown as SDKMessage,
          undefined,
        ),
      );
      yield* Effect.promise(() => journal.turnSubmitted("original-turn"));
      yield* Effect.promise(() => journal.turnSubmitted("original-turn"));
      yield* Effect.promise(() =>
        journal.observeSdkMessage(
          {
            type: "assistant",
            session_id: "subagent-session",
            uuid: "subagent-observation",
            parent_tool_use_id: "subagent-tool",
            message: { id: "subagent-message", model: DEFAULT_MODEL },
          } as unknown as SDKMessage,
          "original-turn",
        ),
      );
      yield* Effect.promise(() =>
        journal.observeSdkMessage(
          {
            type: "assistant",
            session_id: "original-session",
            uuid: "assistant-observation",
            parent_tool_use_id: null,
            message: { id: "upstream-message-observation", model: DEFAULT_MODEL },
          } as unknown as SDKMessage,
          "original-turn",
        ),
      );
      yield* Effect.promise(() =>
        journal.observeSdkMessage(
          {
            type: "result",
            subtype: "success",
            session_id: "original-session",
            uuid: "result-observation",
            is_error: false,
          } as unknown as SDKMessage,
          "original-turn",
        ),
      );
      yield* Effect.promise(() => journal.sdkStreamJoined());
      yield* Effect.promise(() => journal.sdkQueryCloseReturned());
      child.stdin.end("finish");
      yield* Effect.promise(() => closed);
      yield* Effect.promise(() => journal.drain(new AbortController().signal));
      expect(operations.map((value) => value.operation)).toEqual([
        {
          version: 1,
          action: "sdk_observe",
          offer_id: offerId,
          controller_id: controllerId,
          sdk_observation: { version: 1, sequence: 0, kind: "child-spawned", pid: child.pid },
        },
        {
          version: 1,
          action: "sdk_observe",
          offer_id: offerId,
          controller_id: controllerId,
          sdk_observation: {
            version: 1,
            sequence: 1,
            kind: "sdk-init",
            session_id: "original-session",
            init_id: "init-observation",
          },
        },
        {
          version: 1,
          action: "sdk_observe",
          offer_id: offerId,
          controller_id: controllerId,
          sdk_observation: {
            version: 1,
            sequence: 2,
            kind: "turn-submitted",
            turn_id: "original-turn",
          },
        },
        {
          version: 1,
          action: "sdk_observe",
          offer_id: offerId,
          controller_id: controllerId,
          sdk_observation: {
            version: 1,
            sequence: 3,
            kind: "parent-assistant",
            session_id: "original-session",
            turn_id: "original-turn",
            message_id: "upstream-message-observation",
            message_model: DEFAULT_MODEL,
            assistant_id: "assistant-observation",
          },
        },
        {
          version: 1,
          action: "sdk_observe",
          offer_id: offerId,
          controller_id: controllerId,
          sdk_observation: {
            version: 1,
            sequence: 4,
            kind: "sdk-result",
            session_id: "original-session",
            turn_id: "original-turn",
            result_id: "result-observation",
            subtype: "success",
            is_error: false,
          },
        },
        {
          version: 1,
          action: "sdk_observe",
          offer_id: offerId,
          controller_id: controllerId,
          sdk_observation: { version: 1, sequence: 5, kind: "sdk-stream-joined" },
        },
        {
          version: 1,
          action: "sdk_observe",
          offer_id: offerId,
          controller_id: controllerId,
          sdk_observation: { version: 1, sequence: 6, kind: "sdk-query-close-returned" },
        },
        {
          version: 1,
          action: "sdk_observe",
          offer_id: offerId,
          controller_id: controllerId,
          sdk_observation: {
            version: 1,
            sequence: 7,
            kind: "child-closed",
            pid: child.pid,
            exit_code: 0,
          },
        },
      ]);
      expect(new Set(operations.map((value) => value.requestId)).size).toBe(8);
      expect(journal.currentSdkSessionId()).toBe("original-session");
    }).pipe(Effect.scoped),
);
it.effect(
  "rejects wrong acknowledgement sequence, execution claims, extra fields and native error envelopes",
  () =>
    Effect.gen(function* () {
      for (const reply of [
        { version: 1, state: "sdk_observed", sequence: 1, execution_ready: false },
        { version: 1, state: "sdk_observed", sequence: 0, execution_ready: true },
        { version: 1, state: "sdk_observed", sequence: 0, execution_ready: false, actual: {} },
        { version: 1, state: "unavailable" },
      ]) {
        let calls = 0;
        const journal = createNativeSupervisorSdkSourceJournal({
          offerId,
          controllerId,
          transport: {
            request: async () => {
              calls++;
              return reply;
            },
          },
        });
        const failed = yield* Effect.promise(() =>
          journal.turnSubmitted("control-turn").then(
            () => undefined,
            (cause) => cause,
          ),
        );
        expect(failed).toBeDefined();
        expect(yield* Effect.promise(() => journal.failure)).toBe(failed);
        expect(calls).toBe(1);
        expect(journal.currentSdkSessionId()).toBeUndefined();
      }
    }),
);
it.effect(
  "retains an ambiguous original IPC failure without a second request or replacement controller",
  () =>
    Effect.gen(function* () {
      const cause = new Error("original IPC outcome unknown");
      let calls = 0;
      const journal = createNativeSupervisorSdkSourceJournal({
        offerId,
        controllerId,
        transport: {
          request: async () => {
            calls++;
            throw cause;
          },
        },
      });
      const failure = yield* Effect.promise(() =>
        journal.turnSubmitted("control-turn").then(
          () => undefined,
          (error) => error,
        ),
      );
      expect(failure).toBe(cause);
      expect(yield* Effect.promise(() => journal.failure)).toBe(cause);
      expect(calls).toBe(1);
    }),
);
