// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Probes whether a configured harness can actually run on this host.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * `WorkjetHarnessConfiguration.available` is a checkbox. It records what an
 * operator BELIEVES, and nothing has ever verified it, so a worker profile can
 * name a harness whose executable was never installed, was moved, or was
 * removed after the box was ticked. The failure then appears only when a
 * delegation is already running, which is the worst possible moment and the
 * hardest place to diagnose it.
 *
 * ── The decision is pure; only the spawn is not ─────────────────────────────
 * `classifyHarnessProbe` turns a probe OUTCOME into an availability verdict
 * with no filesystem and no child process, so every branch — including the
 * ones that need a missing binary or a hung process — is testable without
 * arranging one on disk. The effectful half does nothing but run the command
 * and hand the outcome here.
 *
 * ── What a verdict may say ──────────────────────────────────────────────────
 * A closed reason vocabulary, never the probe's stderr. A failing third-party
 * binary's output is untrusted text; carrying it on a typed contract would
 * make every consumer a place it could surface, and an operator cannot act on
 * it anyway. "executable-not-found" and "not-executable" are separate because
 * they need different fixes — install it, versus fix its permissions.
 */
import type {
  WorkjetHarness,
  WorkjetHarnessAvailability,
  WorkjetHarnessAvailabilitySnapshot,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/** How long one harness may take to answer before it counts as unusable. */
export const HARNESS_PROBE_TIMEOUT_MS = 5_000;

/** What actually happened when the probe tried to run a harness. */
export type HarnessProbeOutcome =
  | { readonly _tag: "answered"; readonly executablePath: string; readonly stdout: string }
  | { readonly _tag: "not-found" }
  | { readonly _tag: "not-executable" }
  | { readonly _tag: "timed-out" }
  | { readonly _tag: "failed" };

/**
 * A version, if the harness published a recognizable one.
 *
 * Deliberately permissive: harnesses print wildly different banners, and a
 * strict parser would report a WORKING harness as broken because its version
 * line was shaped unexpectedly. An unparsable banner therefore yields no
 * version rather than an unavailable verdict — the harness ran, which is the
 * question being asked.
 */
export function parseHarnessVersion(stdout: string): string | undefined {
  // `v?` and a boundary BEFORE it, not before the digit: in "v1.2" there is no
  // word boundary between `v` and `1`, so anchoring on the digit silently
  // misses every harness that prefixes its version — which is most of them.
  const match = /(?:^|[^0-9A-Za-z.])v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/.exec(stdout);
  return match?.[1];
}

export function classifyHarnessProbe(input: {
  readonly harness: WorkjetHarness;
  readonly outcome: HarnessProbeOutcome;
}): WorkjetHarnessAvailability {
  switch (input.outcome._tag) {
    case "answered": {
      const version = parseHarnessVersion(input.outcome.stdout);
      return {
        harness: input.harness,
        availability: "available",
        executablePath: input.outcome.executablePath,
        ...(version === undefined ? {} : { version }),
      };
    }
    case "not-found":
      return {
        harness: input.harness,
        availability: "unavailable",
        reason: "executable-not-found",
      };
    case "not-executable":
      return { harness: input.harness, availability: "unavailable", reason: "not-executable" };
    case "timed-out":
      return { harness: input.harness, availability: "unavailable", reason: "timeout" };
    case "failed":
      return { harness: input.harness, availability: "unavailable", reason: "probe-failed" };
  }
}

/**
 * Whether a worker profile's harness may be dispatched to.
 *
 * FAILS CLOSED on an unknown harness. A profile naming a harness the snapshot
 * does not mention has not been shown to work — treating "not probed" as
 * "fine" would reintroduce exactly the unverified optimism this replaces, and
 * would do it silently.
 */
export function isHarnessDispatchable(
  snapshot: WorkjetHarnessAvailabilitySnapshot,
  harness: WorkjetHarness,
): boolean {
  const entry = snapshot.harnesses.find((candidate) => candidate.harness === harness);
  return entry !== undefined && entry.availability === "available";
}

/**
 * The bounded reason a dispatch was refused, or `null` when it may proceed.
 * Returned rather than thrown so a caller can put it on a timeline.
 */
export function harnessDispatchRefusal(
  snapshot: WorkjetHarnessAvailabilitySnapshot,
  harness: WorkjetHarness,
): { readonly harness: WorkjetHarness; readonly reason: string } | null {
  const entry = snapshot.harnesses.find((candidate) => candidate.harness === harness);
  if (entry === undefined) return { harness, reason: "not-probed" };
  if (entry.availability === "available") return null;
  return { harness, reason: entry.reason };
}

export interface HarnessProbePort {
  /** Run one harness's version command and report what happened. */
  readonly probe: (harness: WorkjetHarness) => Effect.Effect<HarnessProbeOutcome>;
}

/**
 * Probe every requested harness and fold the results into one snapshot.
 *
 * Probes run CONCURRENTLY: they are independent, and a serial pass would make
 * the whole snapshot as slow as the sum of every timeout when several
 * harnesses are missing — which is exactly the case an operator hits first.
 */
export const probeHarnessAvailability = (input: {
  readonly port: HarnessProbePort;
  readonly harnesses: ReadonlyArray<WorkjetHarness>;
  readonly nowIso: Effect.Effect<string>;
}): Effect.Effect<WorkjetHarnessAvailabilitySnapshot> =>
  Effect.gen(function* () {
    const probedAt = yield* input.nowIso;
    // Deduplicated: two profiles may name the same harness, and probing it
    // twice would spend a timeout twice to learn the same thing.
    const unique = [...new Set(input.harnesses)];
    const harnesses = yield* Effect.forEach(
      unique,
      (harness) =>
        input.port.probe(harness).pipe(
          Effect.catchCause(() => Effect.succeed({ _tag: "failed" as const })),
          Effect.map((outcome) => classifyHarnessProbe({ harness, outcome })),
        ),
      { concurrency: "unbounded" },
    );
    return { schemaVersion: 1, probedAt, harnesses };
  });

// ===============================
// The effectful half
// ===============================

/**
 * The command each harness answers a version with.
 *
 * `--version` for all of them, and the executable name is the harness's own
 * CLI name. This map is explicit rather than derived from the harness id
 * because the two only look alike: `claude-code` is invoked as `claude`, and a
 * derived name would silently probe a binary that does not exist and report
 * every install as missing.
 */
const HARNESS_EXECUTABLES: Readonly<Record<string, string>> = {
  "claude-code": "claude",
  "codex-cli": "codex",
  opencode: "opencode",
  "grok-cli": "grok",
  "cursor-agent": "cursor-agent",
  "pi-code": "pi",
};

/**
 * A probe port backed by a real child process.
 *
 * It runs `<cli> --version` and nothing else. It never passes user input, so
 * there is no argument-injection surface, and `shell: false` keeps the name
 * from being interpreted. A harness that hangs is bounded by
 * {@link HARNESS_PROBE_TIMEOUT_MS} rather than left to block the pass.
 */
export const makeChildProcessHarnessProbePort = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): HarnessProbePort => ({
  probe: (harness) =>
    Effect.gen(function* () {
      const executable = HARNESS_EXECUTABLES[harness];
      if (executable === undefined) {
        // An unknown harness is not a probe failure — this server simply does
        // not know how to ask it, which is a different thing from asking and
        // being refused.
        return { _tag: "not-found" } as const;
      }
      const child = yield* spawner.spawn(
        ChildProcess.make(executable, ["--version"], { extendEnv: true, shell: false }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.mkString,
            Effect.map((text) => text.slice(0, 512)),
          ),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return exitCode === 0
        ? ({ _tag: "answered", executablePath: executable, stdout } as const)
        : ({ _tag: "failed" } as const);
    }).pipe(
      Effect.scoped,
      Effect.timeout(Duration.millis(HARNESS_PROBE_TIMEOUT_MS)),
      Effect.catchTag("TimeoutError", () => Effect.succeed({ _tag: "timed-out" as const })),
      // A spawn that cannot start is the ordinary "not installed" case; it is
      // by far the most common outcome and must not read as a broken probe.
      Effect.catchCause(() => Effect.succeed({ _tag: "not-found" as const })),
    ),
});
