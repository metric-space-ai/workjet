// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  type WorkjetHarness,
  type WorkjetHarnessAvailabilitySnapshot,
} from "@workjet/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@workjet/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  classifyHarnessProbe,
  configuredHarnessExecutable,
  harnessDispatchRefusal,
  isHarnessDispatchable,
  makeChildProcessHarnessProbePort,
  parseHarnessVersion,
  probeHarnessAvailability,
  type HarnessProbeOutcome,
} from "./WorkjetHarnessAvailability.ts";

const CLAUDE = "claude-code" as WorkjetHarness;
const CODEX = "codex-cli" as WorkjetHarness;

it("resolves all server-configurable harness paths", () => {
  const providers = DEFAULT_SERVER_SETTINGS.providers;
  const configured = {
    providers: {
      codex: { ...providers.codex, binaryPath: "/custom/codex" },
      claudeAgent: { ...providers.claudeAgent, binaryPath: "/custom/claude" },
      cursor: { ...providers.cursor, binaryPath: "/custom/cursor" },
      grok: { ...providers.grok, binaryPath: "/custom/grok" },
      opencode: { ...providers.opencode, binaryPath: "/custom/opencode" },
      greppy: { ...providers.greppy, binaryPath: "/custom/greppy" },
      minimax: { ...providers.minimax, binaryPath: "/custom/mcode" },
    },
  };
  for (const [harness, expected] of [
    ["codex-cli", "/custom/codex"],
    ["claude-code", "/custom/claude"],
    ["cursor-agent", "/custom/cursor"],
    ["grok-cli", "/custom/grok"],
    ["opencode", "/custom/opencode"],
    ["greppy", "/custom/greppy"],
    ["minimax-code", "/custom/mcode"],
  ] as const) {
    assert.equal(configuredHarnessExecutable(configured, harness), expected);
  }
  assert.isUndefined(configuredHarnessExecutable(configured, "pi-code"));
});

it("probes the configured Pi executable without guessing between named instances", () => {
  const pi = { driver: ProviderDriverKind.make("pi"), enabled: true, config: { binaryPath: "/configured/pi" } };
  const settings = { ...DEFAULT_SERVER_SETTINGS, providerInstances: { [ProviderInstanceId.make("pi-custom")]: pi } };
  assert.equal(configuredHarnessExecutable(settings, "pi-code"), "/configured/pi");
  assert.isUndefined(configuredHarnessExecutable({ ...settings, providerInstances: { ...settings.providerInstances, [ProviderInstanceId.make("pi-other")]: pi } }, "pi-code"));
});

it("prefers the canonical provider instance path and rejects a mismatched driver", () => {
  const codex = ProviderInstanceId.make("codex");
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [codex]: {
        driver: ProviderDriverKind.make("codex"),
        config: { binaryPath: "/configured/instance/codex" },
      },
    },
  };
  assert.equal(configuredHarnessExecutable(settings, CODEX), "/configured/instance/codex");
  const mismatched = {
    ...settings,
    providerInstances: {
      [codex]: {
        driver: ProviderDriverKind.make("grok"),
        config: { binaryPath: "/foreign/driver" },
      },
    },
  };
  assert.equal(configuredHarnessExecutable(mismatched, CODEX), settings.providers.codex.binaryPath);
});

it.layer(NodeServices.layer)("configured harness executables", (it) => {
  it.effect("runs the configured executable for Codex and Claude", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const port = makeChildProcessHarnessProbePort(spawner, () =>
        Effect.succeed(process.execPath),
      );
      for (const harness of [CODEX, CLAUDE]) {
        const result = yield* port.probe(harness);
        assert.deepEqual(result, {
          _tag: "answered",
          executablePath: process.execPath,
          stdout: `${process.version}\n`,
        });
      }
    }),
  );

  it.effect("reads settings again and does not fall back when a configured path is missing", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      let executable = process.execPath;
      const port = makeChildProcessHarnessProbePort(spawner, () => Effect.sync(() => executable));
      assert.equal((yield* port.probe(CODEX))._tag, "answered");
      executable = `${process.execPath}/missing-workjet-harness`;
      assert.deepEqual(yield* port.probe(CODEX), { _tag: "not-found" });
    }),
  );

  it.effect("keeps CLI defaults and treats configured paths as literal executable names", () =>
    Effect.gen(function* () {
      const actualSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const commands: Array<{ command: string; args: readonly string[]; shell: unknown }> = [];
      const spawner: ChildProcessSpawner.ChildProcessSpawner["Service"] = {
        ...actualSpawner,
        spawn: (command) => {
          if (command._tag === "StandardCommand") {
            commands.push({
              command: command.command,
              args: command.args,
              shell: command.options.shell,
            });
          }
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "test executable is absent",
            }),
          );
        },
      };
      const defaults = makeChildProcessHarnessProbePort(spawner);
      yield* defaults.probe(CODEX);
      yield* defaults.probe(CLAUDE);
      yield* defaults.probe("opencode");
      const literal = "/opt/coding tools/codex;echo unexpected";
      yield* makeChildProcessHarnessProbePort(spawner, () => Effect.succeed(literal)).probe(CODEX);
      assert.deepEqual(
        commands,
        ["codex", "claude", "opencode", literal].map((command) => ({
          command,
          args: ["--version"],
          shell: false,
        })),
      );
    }),
  );
});

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
