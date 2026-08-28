import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ProviderInstanceId,
  ThreadId,
  WorkjetSessionImportCandidate,
  WorkjetSessionImportInput,
} from "./index.ts";

describe("Workjet static session import contracts", () => {
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
});
