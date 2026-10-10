import { describe, expect, it } from "@effect/vitest";
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

const decodeConfig = Schema.decodeUnknownSync(WorkjetThreadConfig);

describe("autonomous worktree execution admission", () => {
  it.effect("decodes a project policy reference without treating it as a grant", () =>
    Effect.gen(function* () {
      const config = decodeConfig({
        ...DEFAULT_WORKJET_THREAD_CONFIG,
        schemaVersion: 2,
        executionPolicy: {
          mode: "autonomous-worktree",
          projectId: ProjectId.make("owner-project"),
          revision: 2,
        },
      });
      const result = yield* Effect.result(
        requireEnforcedExecutionPolicy("startSession", ProviderDriverKind.make("claudeAgent"), config),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.issue).toMatch(/no enforced team-worktree/);
    }),
  );

  it.effect("preserves legacy behavior and does not invent support from a provider name", () =>
    Effect.gen(function* () {
      for (const provider of ["codex", "claudeAgent", "grok", "opencode", "minimax", "greppy", "pi"]) {
        yield* requireEnforcedExecutionPolicy("startSession", ProviderDriverKind.make(provider), DEFAULT_WORKJET_THREAD_CONFIG);
      }
      yield* requirePersistedEnforcedExecutionPolicy("recover", ProviderDriverKind.make("codex"), {});
      yield* requirePersistedEnforcedExecutionPolicy("recover", ProviderDriverKind.make("codex"), { workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG });
    }),
  );

  it.effect("rejects malformed and future persisted policy references without dropping them", () =>
    Effect.gen(function* () {
      for (const executionPolicy of [null, {}, { mode: "future-mode" }, { mode: "autonomous-worktree", revision: 9 }]) {
        const result = yield* Effect.result(
          requirePersistedEnforcedExecutionPolicy("recover", ProviderDriverKind.make("codex"), {
            workjetConfig: { schemaVersion: 999, executionPolicy },
          }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.issue).toMatch(/Full access is not an alternative/);
      }
    }),
  );
});
