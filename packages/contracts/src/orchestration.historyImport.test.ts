import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ClientOrchestrationCommand,
  OrchestrationCommand,
  DEFAULT_WORKJET_THREAD_CONFIG,
} from "./index.ts";

const decodeInternal = Schema.decodeUnknownSync(OrchestrationCommand);
const decodeClient = Schema.decodeUnknownSync(ClientOrchestrationCommand);
const NOW = "2026-10-04T12:00:00.000Z";
const message = { messageId: "message-1", role: "user", text: "Copied", createdAt: NOW };
const command = {
  type: "thread.history.import",
  commandId: "import-1",
  threadId: "new-copy",
  messages: [message],
  createdAt: NOW,
  bootstrap: {
    createThread: {
      projectId: "project-1",
      title: "Copied conversation",
      modelSelection: { instanceId: "codex", model: "fixture-model" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    },
  },
};
describe("server-internal atomic history import", () => {
  it("accepts a typed fresh-thread bootstrap and retains ordinary append imports", () => {
    expect(decodeInternal(command)).toEqual(command);
    const { bootstrap: _bootstrap, ...append } = command;
    expect(decodeInternal(append)).toEqual(append);
  });
  it("rejects history imports through the public client command contract", () => {
    expect(() => decodeClient(command)).toThrow();
  });
  it("requires complete thread metadata when bootstrap is present", () => {
    expect(() => decodeInternal({ ...command, bootstrap: {} })).toThrow();
    expect(() => decodeInternal({ ...command, bootstrap: { createThread: {} } })).toThrow();
  });
  it("preserves the one-to-200 message bound for atomic imports", () => {
    expect(() => decodeInternal({ ...command, messages: [] })).toThrow();
    expect(() =>
      decodeInternal({ ...command, messages: Array.from({ length: 201 }, () => message) }),
    ).toThrow();
    expect(
      decodeInternal({ ...command, messages: Array.from({ length: 200 }, () => message) }),
    ).toMatchObject({ messages: expect.any(Array) });
  });
});
