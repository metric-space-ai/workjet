// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { WorkjetHarness, WorkjetHarnessAvailabilitySnapshot } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  classifyHarnessProbe,
  harnessDispatchRefusal,
  isHarnessDispatchable,
  parseHarnessVersion,
  probeHarnessAvailability,
  type HarnessProbeOutcome,
} from "./WorkjetHarnessAvailability.ts";

const CLAUDE = "claude-code" as WorkjetHarness;
const CODEX = "codex-cli" as WorkjetHarness;

const snapshot = (
  harnesses: WorkjetHarnessAvailabilitySnapshot["harnesses"],
): WorkjetHarnessAvailabilitySnapshot => ({
  schemaVersion: 1,
  probedAt: "2026-08-20T10:00:00.000Z",
  harnesses,
});

describe("classifying a harness probe", () => {
  it("separates 'not installed' from 'not executable', because the fixes differ", () => {
    // One says install it, the other says fix its permissions. Collapsing them
    // into one reason sends an operator down the wrong path.
    assert.deepEqual(classifyHarnessProbe({ harness: CLAUDE, outcome: { _tag: "not-found" } }), {
      harness: CLAUDE,
      availability: "unavailable",
      reason: "executable-not-found",
    });
    assert.deepEqual(
      classifyHarnessProbe({ harness: CLAUDE, outcome: { _tag: "not-executable" } }),
      { harness: CLAUDE, availability: "unavailable", reason: "not-executable" },
    );
  });

  it("reports a harness that ran but printed an odd banner as AVAILABLE", () => {
    // The question is "can this run", not "does it version itself the way I
    // expect". A strict parser here would report a working harness as broken.
    const verdict = classifyHarnessProbe({
      harness: CLAUDE,
      outcome: { _tag: "answered", executablePath: "/usr/local/bin/claude", stdout: "ready" },
    });

    assert.equal(verdict.availability, "available");
    assert.isFalse("version" in verdict && verdict.version !== undefined);
  });

  it("carries the resolved path so an operator can see WHICH binary answered", () => {
    const verdict = classifyHarnessProbe({
      harness: CLAUDE,
      outcome: {
        _tag: "answered",
        executablePath: "/opt/homebrew/bin/claude",
        stdout: "claude 2.4.1 (build 9)",
      },
    });

    assert.equal(
      verdict.availability === "available" ? verdict.executablePath : null,
      "/opt/homebrew/bin/claude",
    );
    assert.equal(verdict.availability === "available" ? verdict.version : null, "2.4.1");
  });

  it("never carries the probe's output", () => {
    // A failing third-party binary's stderr is untrusted text. Putting it on
    // the contract would make every consumer a place it could surface.
    const verdict = classifyHarnessProbe({
      harness: CLAUDE,
      outcome: { _tag: "failed" },
    });

    assert.notInclude(JSON.stringify(verdict), "stdout");
    assert.deepEqual(Object.keys(verdict).sort(), ["availability", "harness", "reason"]);
  });
});

describe("parseHarnessVersion", () => {
  it("reads the common shapes and refuses to invent one", () => {
    assert.equal(parseHarnessVersion("codex-cli 0.12.3"), "0.12.3");
    assert.equal(parseHarnessVersion("v1.2"), "1.2");
    assert.equal(parseHarnessVersion("2.0.0-beta.4"), "2.0.0-beta.4");
    assert.isUndefined(parseHarnessVersion("ready"));
    assert.isUndefined(parseHarnessVersion(""));
  });
});

describe("dispatch gating", () => {
  it("fails CLOSED on a harness the snapshot never probed", () => {
    // "Not probed" is not "fine". Treating it as fine reintroduces exactly the
    // unverified optimism the live probe replaces, and does it silently.
    const empty = snapshot([]);

    assert.isFalse(isHarnessDispatchable(empty, CLAUDE));
    assert.deepEqual(harnessDispatchRefusal(empty, CLAUDE), {
      harness: CLAUDE,
      reason: "not-probed",
    });
  });

  it("allows only the harness that actually answered", () => {
    const mixed = snapshot([
      { harness: CLAUDE, availability: "available", executablePath: "/bin/claude" },
      { harness: CODEX, availability: "unavailable", reason: "executable-not-found" },
    ]);

    assert.isTrue(isHarnessDispatchable(mixed, CLAUDE));
    assert.isNull(harnessDispatchRefusal(mixed, CLAUDE));
    assert.isFalse(isHarnessDispatchable(mixed, CODEX));
    assert.deepEqual(harnessDispatchRefusal(mixed, CODEX), {
      harness: CODEX,
      reason: "executable-not-found",
    });
  });
});

describe("probing a set of harnesses", () => {
  const port = (outcomes: Partial<Record<string, HarnessProbeOutcome>>, calls: string[]) => ({
    probe: (harness: WorkjetHarness) =>
      Effect.sync(() => {
        calls.push(harness);
        return outcomes[harness] ?? ({ _tag: "not-found" } as HarnessProbeOutcome);
      }),
  });

  it.effect("probes each harness once even when several profiles name it", () =>
    Effect.gen(function* () {
      // Probing a missing harness twice spends its whole timeout twice to
      // learn the same thing.
      const calls: string[] = [];
      const result = yield* probeHarnessAvailability({
        port: port({}, calls),
        harnesses: [CLAUDE, CODEX, CLAUDE, CODEX, CLAUDE],
        nowIso: Effect.succeed("2026-08-20T10:00:00.000Z"),
      });

      assert.deepEqual(calls.sort(), [CLAUDE, CODEX].sort());
      assert.lengthOf(result.harnesses, 2);
    }),
  );

  it.effect("a port that dies marks THAT harness unusable, not the whole pass", () =>
    Effect.gen(function* () {
      // One broken probe must not cost the operator every other verdict.
      const result = yield* probeHarnessAvailability({
        port: {
          probe: (harness) =>
            harness === CLAUDE
              ? Effect.die("the spawner exploded")
              : Effect.succeed({
                  _tag: "answered",
                  executablePath: "/bin/codex",
                  stdout: "codex 1.0.0",
                } as HarnessProbeOutcome),
        },
        harnesses: [CLAUDE, CODEX],
        nowIso: Effect.succeed("2026-08-20T10:00:00.000Z"),
      });

      const claude = result.harnesses.find((entry) => entry.harness === CLAUDE);
      const codex = result.harnesses.find((entry) => entry.harness === CODEX);
      assert.equal(claude?.availability, "unavailable");
      assert.equal(codex?.availability, "available");
    }),
  );

  it.effect("stamps ONE probedAt for the pass, not one per entry", () =>
    Effect.gen(function* () {
      // They are probed together; a per-entry stamp would invite treating one
      // verdict as fresher than another when it is not.
      const result = yield* probeHarnessAvailability({
        port: port({}, []),
        harnesses: [CLAUDE, CODEX],
        nowIso: Effect.succeed("2026-08-20T10:00:00.000Z"),
      });

      assert.equal(result.probedAt, "2026-08-20T10:00:00.000Z");
      for (const entry of result.harnesses) {
        assert.notProperty(entry, "probedAt");
      }
    }),
  );
});
