import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import type { CheckpointManifest } from "./ctoxSync.generated.ts";
import { CheckpointManifestSchema } from "./ctoxSync.schema.generated.ts";

const decode = Schema.decodeUnknownSync(CheckpointManifestSchema, { onExcessProperty: "error" });
const artifact = { sha256: "a".repeat(64), sizeBytes: 12 };
const manifest = {
  version: 2,
  session: {
    version: 1,
    scopeId: "scope-test",
    sessionId: "session-test",
    harness: "codex",
    harnessVersion: "test",
    modelRouteId: "route-test",
    gatewayAccountId: "account-test",
    modelId: "model-test",
    requiredCapabilities: [],
    credentialReferences: [],
  },
  sequence: 7,
  workspaceState: {
    baseCommit: "b".repeat(40),
    indexPatch: artifact,
    worktreePatch: artifact,
    requiredUntracked: [{ path: "notes.txt", kind: "file", artifact, executable: false }],
    deletedPaths: ["removed.txt"],
  },
  history: [artifact],
  attachments: [],
  workspace: [],
  providerState: [],
  pendingEffects: [],
} satisfies CheckpointManifest;

describe("portable checkpoint wire contract", () => {
  it("preserves the complete Git reconstruction payload", () => {
    expect(decode(manifest)).toEqual(manifest);
  });

  it("rejects the old optional-base-commit payload", () => {
    const { workspaceState, ...legacy } = manifest;
    expect(() =>
      decode({ ...legacy, version: 1, baseCommit: workspaceState.baseCommit }),
    ).toThrow();
  });

  it("rejects incomplete Git state and unsafe artifact byte counts", () => {
    for (const key of Object.keys(manifest.workspaceState)) {
      const state: Record<string, unknown> = { ...manifest.workspaceState };
      delete state[key];
      expect(() => decode({ ...manifest, workspaceState: state })).toThrow();
    }
    for (const sizeBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        decode({
          ...manifest,
          workspaceState: {
            ...manifest.workspaceState,
            indexPatch: { ...artifact, sizeBytes },
          },
        }),
      ).toThrow();
    }
  });
});
