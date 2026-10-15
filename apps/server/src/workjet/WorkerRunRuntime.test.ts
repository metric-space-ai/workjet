// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  EventId,
  ThreadId,
  type ProviderRuntimeEvent,
  ProviderDriverKind,
} from "@workjet/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { layer as ledgerLayer, WorkerRunLedger } from "./WorkerRunLedger.ts";
import { workerRunProgressFromEvent } from "./WorkerRunRuntime.ts";

const base = {
  eventId: EventId.make("event-a"),
  threadId: ThreadId.make("run-a"),
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-10-13T09:00:00.000Z",
};
describe("worker runtime ledger milestones", () => {
  it("records actual start without guessing missing model facts", () => {
    const value = workerRunProgressFromEvent({
      ...base,
      type: "turn.started",
      payload: {},
    } as ProviderRuntimeEvent);
    expect(value?.startedAt).toBe(base.createdAt);
    expect(value?.execution?.model).toBeNull();
    expect(value?.execution?.harness).toBe("codex");
  });
  it("distinguishes first output from tool output and retains recoverable sessions", () => {
    expect(
      workerRunProgressFromEvent({
        ...base,
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "answer" },
      } as ProviderRuntimeEvent)?.firstOutputAt,
    ).toBe(base.createdAt);
    expect(
      workerRunProgressFromEvent({
        ...base,
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "" },
      } as ProviderRuntimeEvent),
    ).toBeUndefined();
    expect(
      workerRunProgressFromEvent({
        ...base,
        type: "session.exited",
        payload: { recoverable: true, exitKind: "error" },
      } as ProviderRuntimeEvent),
    ).toBeUndefined();
    expect(
      workerRunProgressFromEvent({
        ...base,
        type: "session.exited",
        payload: { recoverable: false, exitKind: "error" },
      } as ProviderRuntimeEvent)?.abortClass,
    ).toBe("task");
  });
  // Claude and Codex adapters never set `recoverable`; their exit must still close the run.
  it.effect("records terminal_at for a session exit that does not claim to be recoverable", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const ledger = yield* WorkerRunLedger;
      yield* ledger.queue(
        {
          runId: base.threadId,
          parent: { threadId: "parent", sessionId: null, model: null, harness: null },
          worker: { model: null, harness: null, providerRoute: null, reasoning: null },
          briefSha256: "a".repeat(64),
          taskType: "backend",
          difficulty: "standard",
          selection: "manual",
        },
        base.createdAt,
      );
      for (const exitKind of ["graceful", "error"] as const) {
        const progress = workerRunProgressFromEvent({
          ...base,
          type: "session.exited",
          payload: { reason: "Session stopped", exitKind },
        } as ProviderRuntimeEvent);
        expect(progress?.terminalAt).toBe(base.createdAt);
        expect(progress?.abortClass).toBe(exitKind === "error" ? "task" : undefined);
      }
      const exited = workerRunProgressFromEvent({
        ...base,
        type: "session.exited",
        payload: { reason: "Session stopped", exitKind: "graceful" },
      } as ProviderRuntimeEvent);
      yield* ledger.observe(exited!);
      const saved = Option.getOrThrow(yield* ledger.get(base.threadId));
      expect(saved.terminalAt).toBe(base.createdAt);
    }).pipe(Effect.provide(ledgerLayer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())))),
  );
});
