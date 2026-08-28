// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, expect, it } from "vite-plus/test";

import type {
  EnvironmentId,
  WorkjetHandoffBranchRef,
  WorkjetWorkerAddress,
} from "@t3tools/contracts";
import {
  WORKJET_HANDOFF_SNAPSHOT_MAX_BYTES,
  WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGES,
  WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGE_CHARS,
  composeWorkjetHandoffSnapshot,
  formatWorkjetHandoffBranchLine,
  type WorkjetHandoffSnapshotMessage,
} from "./WorkjetHandoffSnapshot.ts";

const sourceThread = {
  schemaVersion: 1,
  workspaceId: "ctox:mesh-alpha",
  environmentId: "environment-a",
  threadId: "thread-source",
} as unknown as WorkjetWorkerAddress;

const targetEnvironmentId = "environment-b" as EnvironmentId;

const branch = {
  schemaVersion: 1,
  branch: "agent/th-thread-handoff",
  headCommit: "9668c3e14",
  remoteConfigured: true,
} as unknown as WorkjetHandoffBranchRef;

const message = (index: number, text: string): WorkjetHandoffSnapshotMessage => ({
  role: index % 2 === 0 ? "user" : "assistant",
  text,
  createdAt: `2026-08-19T10:${String(index).padStart(2, "0")}:00.000Z`,
});

const compose = (messages: ReadonlyArray<WorkjetHandoffSnapshotMessage>, note?: string) =>
  composeWorkjetHandoffSnapshot({
    sourceThread,
    targetEnvironmentId,
    title: "Thread handoff contract",
    branch,
    ...(note === undefined ? {} : { note }),
    note,
    composedAt: "2026-08-19T12:00:00.000Z",
    messages,
  });

describe("composeWorkjetHandoffSnapshot", () => {
  it("carries the source address, title, and branch, and says it is not a history", () => {
    const composition = compose([message(0, "Start the slice.")]);
    expect(composition.text).toContain("thread-source");
    expect(composition.text).toContain("environment-a");
    expect(composition.text).toContain("ctox:mesh-alpha");
    expect(composition.text).toContain("environment-b");
    expect(composition.text).toContain("Thread handoff contract");
    expect(composition.text).toContain("agent/th-thread-handoff");
    expect(composition.text).toContain("BOUNDED CONTEXT SNAPSHOT");
    expect(composition.text).toContain("nothing was replicated");
  });

  it("never claims the branch was pushed and never leaks a filesystem path", () => {
    const composition = compose([message(0, "Start the slice.")]);
    expect(composition.text).toContain("did NOT push anything");
    expect(composition.text).not.toContain("/Volumes/");
    expect(composition.text).not.toMatch(/worktreePath/i);
  });

  it("states honestly when no branch and no head commit are known", () => {
    expect(formatWorkjetHandoffBranchLine(undefined)).toContain("none recorded");
    const withoutCommit = {
      schemaVersion: 1,
      branch: "agent/no-commit",
      remoteConfigured: false,
    } as unknown as WorkjetHandoffBranchRef;
    const line = formatWorkjetHandoffBranchLine(withoutCommit);
    expect(line).toContain("head commit not resolved");
    expect(line).toContain("no remote configured");
    expect(line).not.toContain("pushed anything");
  });

  it("carries only the newest messages once the count bound is passed", () => {
    const messages = Array.from({ length: WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGES + 5 }, (_, index) =>
      message(index, `message-${index}`),
    );
    const composition = compose(messages);
    expect(composition.totalMessages).toBe(WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGES + 5);
    expect(composition.includedMessages).toBe(WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGES);
    // The oldest are the ones left behind, and the tail stays contiguous.
    expect(composition.text).not.toContain("message-0\n");
    expect(composition.text).toContain(`message-${WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGES + 4}`);
    expect(composition.text).toContain(`last ${WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGES} of`);
    expect(composition.droppedByByteCeiling).toBe(false);
  });

  it("renders the carried tail oldest-first", () => {
    const composition = compose([message(0, "first"), message(1, "second"), message(2, "third")]);
    const first = composition.text.indexOf("first");
    const second = composition.text.indexOf("second");
    const third = composition.text.indexOf("third");
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it("cuts an over-long single message and reports that it did", () => {
    const composition = compose([
      message(0, "x".repeat(WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGE_CHARS + 500)),
    ]);
    expect(composition.truncatedMessages).toBe(1);
    expect(composition.text).toContain("[message truncated for the handoff snapshot]");
    expect(composition.text).not.toContain(
      "x".repeat(WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGE_CHARS + 1),
    );
  });

  it("stays under the transfer ceiling and reports dropping the oldest messages", () => {
    // Twenty near-maximal messages far exceed the byte ceiling, so the ceiling —
    // not the count bound — must be what stops the walk.
    const messages = Array.from({ length: WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGES }, (_, index) =>
      message(index, "y".repeat(WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGE_CHARS)),
    );
    const composition = compose(messages);
    expect(composition.byteLength).toBeLessThanOrEqual(WORKJET_HANDOFF_SNAPSHOT_MAX_BYTES);
    expect(composition.includedMessages).toBeLessThan(WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGES);
    expect(composition.droppedByByteCeiling).toBe(true);
    // The newest message survives; the oldest is the one dropped.
    expect(composition.text).toContain("2026-08-19T10:39:00.000Z");
  });

  it("composes an honest snapshot for a thread with no message text", () => {
    const composition = compose([message(0, "   ")]);
    expect(composition.includedMessages).toBe(0);
    expect(composition.text).toContain("None carried");
    expect(composition.byteLength).toBeGreaterThan(0);
  });

  it("carries the operator note verbatim and omits the section when absent", () => {
    const withNote = compose([message(0, "hello")], "Continue with any harness.");
    expect(withNote.text).toContain("## Operator note");
    expect(withNote.text).toContain("Continue with any harness.");
    const withoutNote = compose([message(0, "hello")]);
    expect(withoutNote.text).not.toContain("## Operator note");
  });

  it("is deterministic: the same input composes byte-identical bytes", () => {
    const messages = [message(0, "one"), message(1, "two")];
    expect(compose(messages).text).toBe(compose(messages).text);
  });
});
