// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { WorkjetArtifactReferences } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  describeResolution,
  MAX_RESOLVED_REFERENCES,
  resolveArtifactReferences,
  type ArtifactResolutionPort,
} from "./WorkjetArtifactResolution.ts";

const refs = (
  commitHashes: ReadonlyArray<string>,
  paths: ReadonlyArray<string> = [],
): WorkjetArtifactReferences =>
  ({ schemaVersion: 1, commitHashes, paths, diffs: [] }) as unknown as WorkjetArtifactReferences;

const port = (found: (value: string) => boolean): ArtifactResolutionPort => ({
  hasCommit: ({ hash }) => Effect.succeed(found(hash)),
  hasPath: ({ path }) => Effect.succeed(found(path)),
});

describe("resolving a peer's references against our own state", () => {
  it.effect("answers from THIS machine, never from what the peer claimed", () =>
    Effect.gen(function* () {
      // The peer named two commits. Only one exists here. A surface that
      // displayed the peer's list as fact would show both as real work.
      const resolved = yield* resolveArtifactReferences({
        artifacts: refs(["aaaaaaa", "bbbbbbb"]),
        worktreePath: "/tmp/wt",
        port: port((value) => value === "aaaaaaa"),
      });

      assert.deepEqual(
        resolved.commits.map((entry) => entry.state),
        ["present", "absent"],
      );
      assert.isFalse(resolved.incomplete);
    }),
  );

  it.effect("keeps 'could not look' apart from 'not here'", () =>
    Effect.gen(function* () {
      // Without a repository this machine did not look at all. Reporting
      // `absent` would tell the operator the peer's work is missing, when the
      // truth is we never checked — different actions follow from each.
      const resolved = yield* resolveArtifactReferences({
        artifacts: refs(["aaaaaaa"], ["src/app.ts"]),
        worktreePath: null,
        port: port(() => true),
      });

      assert.deepEqual(
        [...resolved.commits, ...resolved.paths].map((entry) => entry.state),
        ["unchecked", "unchecked"],
      );
      assert.isTrue(resolved.incomplete);
    }),
  );

  it.effect("a probe that fails is unchecked, not evidence of absence", () =>
    Effect.gen(function* () {
      // A broken git call says nothing about whether the peer's commit exists.
      const resolved = yield* resolveArtifactReferences({
        artifacts: refs(["aaaaaaa"]),
        worktreePath: "/tmp/wt",
        port: {
          hasCommit: () => Effect.die("git exploded"),
          hasPath: () => Effect.succeed(false),
        },
      });

      assert.equal(resolved.commits[0]?.state, "unchecked");
      assert.isTrue(resolved.incomplete);
    }),
  );

  it.effect("bounds how many local reads one arriving result can cause", () =>
    Effect.gen(function* () {
      // The contract caps the arrays, but each reference costs a git or
      // filesystem call. A peer filling every slot must not turn one result
      // into hundreds of local reads.
      let calls = 0;
      const many = Array.from({ length: MAX_RESOLVED_REFERENCES + 20 }, (_u, i) => `c${i}`);
      const resolved = yield* resolveArtifactReferences({
        artifacts: refs(many),
        worktreePath: "/tmp/wt",
        port: {
          hasCommit: () =>
            Effect.sync(() => {
              calls += 1;
              return true;
            }),
          hasPath: () => Effect.succeed(true),
        },
      });

      assert.lengthOf(resolved.commits, MAX_RESOLVED_REFERENCES);
      assert.equal(calls, MAX_RESOLVED_REFERENCES);
    }),
  );

  it.effect("never reaches the network — a reference only found remotely is absent", () =>
    Effect.gen(function* () {
      // Resolution is a LOCAL read. A peer must not be able to make this
      // machine reach out by naming something, so "exists only on the remote"
      // is `absent` here, which is the honest answer rather than a gap.
      const resolved = yield* resolveArtifactReferences({
        artifacts: refs(["only-on-remote"]),
        worktreePath: "/tmp/wt",
        port: port(() => false),
      });

      assert.equal(resolved.commits[0]?.state, "absent");
    }),
  );
});

describe("describeResolution", () => {
  it("counts states and quotes NO peer-supplied text", () => {
    const line = describeResolution({
      commits: [
        { hash: "<script>alert(1)</script>", state: "present" },
        { hash: "bbbbbbb", state: "absent" },
      ],
      paths: [{ path: "../etc/passwd", state: "unchecked" }],
      incomplete: true,
    });

    assert.notInclude(line, "script");
    assert.notInclude(line, "passwd");
    assert.include(line, "1 found here");
    assert.include(line, "1 not here");
    assert.include(line, "1 could not be checked");
  });

  it("says so plainly when there is nothing to resolve", () => {
    assert.equal(
      describeResolution({ commits: [], paths: [], incomplete: false }),
      "No artifact references.",
    );
  });
});
