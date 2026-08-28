// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Resolves artifact references a PEER sent against THIS server's own state.
 *
 * ── The rule this implements, and why it is not obvious ─────────────────────
 * docs/workjet-plan.md: "remote servers resolve references against their own
 * authorized environment state". That is a security property, not a
 * convenience. A reference is a claim made by another machine — a commit hash,
 * a path, a diff range. Displaying it as fact, or fetching it because the
 * sender named it, would let a peer point this machine at work it never did,
 * or at a path outside anything it may read.
 *
 * So nothing here trusts the reference. Every answer is one of three, and the
 * distinction is the whole point:
 *
 *  - `present`   — this machine looked and found it.
 *  - `absent`    — this machine looked and it is not here. NOT an error: a
 *                  branch that was never pushed is legitimately absent, and
 *                  the operator needs to see exactly that.
 *  - `unchecked` — this machine could not look at all (no repository, no
 *                  port). Deliberately distinct from `absent`, because
 *                  "I did not find it" and "I could not look" lead an operator
 *                  to different actions, and collapsing them would make the
 *                  surface lie in the more dangerous direction.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * No fetching, no `git ls-remote`, no network of any kind. Resolution is a
 * LOCAL read. A peer must never be able to make this machine reach out by
 * naming something, and a reference that only exists remotely is `absent`
 * here — which is the honest answer, not a gap.
 */
import type { WorkjetArtifactReferences } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export type ReferenceState = "present" | "absent" | "unchecked";

export interface ResolvedArtifactReferences {
  readonly commits: ReadonlyArray<{ readonly hash: string; readonly state: ReferenceState }>;
  readonly paths: ReadonlyArray<{ readonly path: string; readonly state: ReferenceState }>;
  /** True when at least one reference could not be checked at all. */
  readonly incomplete: boolean;
}

export interface ArtifactResolutionPort {
  /** Does this commit exist in the local repository? Local read only. */
  readonly hasCommit: (input: {
    readonly worktreePath: string;
    readonly hash: string;
  }) => Effect.Effect<boolean>;
  /** Does this repository-relative path exist in the local worktree? */
  readonly hasPath: (input: {
    readonly worktreePath: string;
    readonly path: string;
  }) => Effect.Effect<boolean>;
}

/**
 * How many references one result may have resolved. The contract already caps
 * the arrays, but resolution costs a filesystem or git call EACH, and a
 * hostile peer that fills every slot should not be able to turn one arriving
 * result into hundreds of local reads.
 */
export const MAX_RESOLVED_REFERENCES = 32;

export const resolveArtifactReferences = (input: {
  readonly artifacts: WorkjetArtifactReferences;
  readonly worktreePath: string | null | undefined;
  readonly port?: ArtifactResolutionPort | undefined;
}): Effect.Effect<ResolvedArtifactReferences> =>
  Effect.gen(function* () {
    const commits = input.artifacts.commitHashes.slice(0, MAX_RESOLVED_REFERENCES);
    const paths = input.artifacts.paths.slice(0, MAX_RESOLVED_REFERENCES);

    // No repository or no port: everything is `unchecked`. Reporting `absent`
    // here would tell an operator the peer's work is missing when the truth is
    // that this machine never looked.
    if (input.worktreePath == null || input.port === undefined) {
      return {
        commits: commits.map((hash) => ({ hash, state: "unchecked" as const })),
        paths: paths.map((path) => ({ path, state: "unchecked" as const })),
        incomplete: commits.length > 0 || paths.length > 0,
      };
    }

    const worktreePath = input.worktreePath;
    const port = input.port;
    const check = <T>(
      values: ReadonlyArray<T>,
      probe: (value: T) => Effect.Effect<boolean>,
    ): Effect.Effect<ReadonlyArray<ReferenceState>> =>
      Effect.forEach(
        values,
        (value) =>
          probe(value).pipe(
            Effect.map((found): ReferenceState => (found ? "present" : "absent")),
            // A probe that fails is `unchecked`, never `absent`: a broken git
            // call is not evidence that the peer's commit does not exist.
            Effect.catchCause(() => Effect.succeed("unchecked" as ReferenceState)),
          ),
        { concurrency: "unbounded" },
      );

    const commitStates = yield* check(commits, (hash) => port.hasCommit({ worktreePath, hash }));
    const pathStates = yield* check(paths, (path) => port.hasPath({ worktreePath, path }));

    return {
      commits: commits.map((hash, i) => ({ hash, state: commitStates[i] ?? "unchecked" })),
      paths: paths.map((path, i) => ({ path, state: pathStates[i] ?? "unchecked" })),
      incomplete: [...commitStates, ...pathStates].includes("unchecked"),
    };
  });

/**
 * One bounded line an operator can read, built from counts and closed states
 * only — never from a path or hash the peer supplied, which would put
 * peer-controlled text into a summary.
 */
export function describeResolution(resolved: ResolvedArtifactReferences): string {
  const all = [...resolved.commits.map((c) => c.state), ...resolved.paths.map((p) => p.state)];
  if (all.length === 0) return "No artifact references.";
  const present = all.filter((state) => state === "present").length;
  const unchecked = all.filter((state) => state === "unchecked").length;
  const absent = all.length - present - unchecked;
  const parts = [`${present} found here`];
  if (absent > 0) parts.push(`${absent} not here`);
  if (unchecked > 0) parts.push(`${unchecked} could not be checked`);
  return parts.join(", ") + ".";
}
