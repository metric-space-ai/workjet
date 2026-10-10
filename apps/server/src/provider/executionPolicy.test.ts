import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  ProjectId,
  ProviderDriverKind,
  WorkjetThreadConfig,
} from "@workjet/contracts";
import {
  requireEnforcedExecutionPolicy,
  requirePersistedEnforcedExecutionPolicy,
} from "./executionPolicy.ts";

describe("autonomous worktree execution admission", () => {
  it("decodes a project policy reference without treating it as a grant", async () => {
    const config = Schema.decodeUnknownSync(WorkjetThreadConfig)({
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      schemaVersion: 2,
      executionPolicy: {
        mode: "autonomous-worktree",
        projectId: ProjectId.make("owner-project"),
        revision: 2,
      },
    });
    await expect(
      Effect.runPromise(
        requireEnforcedExecutionPolicy("startSession", ProviderDriverKind.make("claudeAgent"), config),
      ),
    ).rejects.toThrow(/no enforced team-worktree/);
  });

  it("preserves legacy behavior and does not invent support from a provider name", async () => {
    for (const provider of ["codex", "claudeAgent", "grok", "opencode", "minimax", "greppy", "pi"]) {
      await Effect.runPromise(
        requireEnforcedExecutionPolicy("startSession", ProviderDriverKind.make(provider), DEFAULT_WORKJET_THREAD_CONFIG),
      );
    }
    await Effect.runPromise(requirePersistedEnforcedExecutionPolicy("recover", ProviderDriverKind.make("codex"), {}));
    await Effect.runPromise(requirePersistedEnforcedExecutionPolicy("recover", ProviderDriverKind.make("codex"), { workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG }));
  });

  it("rejects malformed and future persisted policy references without dropping them", async () => {
    for (const executionPolicy of [null, {}, { mode: "future-mode" }, { mode: "autonomous-worktree", revision: 9 }]) {
      await expect(
        Effect.runPromise(
          requirePersistedEnforcedExecutionPolicy("recover", ProviderDriverKind.make("codex"), {
            workjetConfig: { schemaVersion: 999, executionPolicy },
          }),
        ),
      ).rejects.toThrow(/Full access is not an alternative/);
    }
  });
});
