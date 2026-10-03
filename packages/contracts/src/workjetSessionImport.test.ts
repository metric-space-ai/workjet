import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ProviderInstanceId,
  ThreadId,
  WorkjetSessionImportCandidate,
  WorkjetSessionImportInput,
  WorkjetSessionImportInspectInput,
} from "./index.ts";

describe("Workjet static session import contracts", () => {
  it("represents an unrecorded source folder without guessing a path", () => {
    const input = {
      candidateId: "wjsi_0123456789abcdef0123456789abcdef",
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      title: "Conversation without folder",
      workspaceRoot: null,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:05:00.000Z",
      sourceSizeBytes: 42,
      importedThreadId: null,
      workspaceAvailable: false,
    };
    const decode = Schema.decodeUnknownSync(WorkjetSessionImportCandidate);
    expect(decode(input).workspaceRoot).toBeNull();
    expect(() => decode({ ...input, workspaceRoot: "" })).toThrow();
  });

  it("exposes opaque candidates without a native source path", () => {
    const decoded = Schema.decodeUnknownSync(WorkjetSessionImportCandidate)({
      candidateId: "wjsi_0123456789abcdef0123456789abcdef",
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      title: "Imported conversation",
      workspaceRoot: "/workspace",
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:05:00.000Z",
      sourceSizeBytes: 42,
      importedThreadId: ThreadId.make("thread-1"),
      workspaceAvailable: true,
    });
    expect(decoded).not.toHaveProperty("sourcePath");
    expect(decoded.candidateId).toMatch(/^wjsi_[a-f0-9]{32}$/u);
  });

  it("requires at least one bounded candidate selection", () => {
    const decode = Schema.decodeUnknownSync(WorkjetSessionImportInput);
    expect(() => decode({ candidateIds: [] })).toThrow();
    expect(() =>
      decode({
        candidateIds: Array.from(
          { length: 21 },
          (_, index) => `wjsi_${index.toString(16).padStart(32, "0")}`,
        ),
      }),
    ).toThrow();
  });

  it("validates paging and search while retaining legacy candidate-only imports", () => {
    const inspect = Schema.decodeUnknownSync(WorkjetSessionImportInspectInput);
    expect(
      inspect({ offset: 100, query: "older conversation", source: "claude-code" }).offset,
    ).toBe(100);
    expect(() => inspect({ offset: -1 })).toThrow();
    expect(() => inspect({ source: "unknown" })).toThrow();
    const candidateIds = ["wjsi_0123456789abcdef0123456789abcdef"];
    const imported = Schema.decodeUnknownSync(WorkjetSessionImportInput);
    expect(imported({ candidateIds })).toEqual({ candidateIds });
    expect(imported({ candidateIds, projectId: "chosen-project" }).projectId).toBe(
      "chosen-project",
    );
  });
});
