// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  EventId,
  ThreadId,
  type ProviderRuntimeEvent,
  ProviderDriverKind,
} from "@workjet/contracts";
import { describe, expect, it } from "@effect/vitest";
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
});
