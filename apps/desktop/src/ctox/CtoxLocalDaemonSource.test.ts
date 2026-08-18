// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import {
  ctoxLocalDaemonInstanceId,
  discoverCtoxLocalDaemonInstances,
  normalizeCtoxLocalDaemonHealthUrl,
  type CtoxLocalDaemonDiscoveryOptions,
  type CtoxLocalDaemonInstance,
} from "./CtoxLocalDaemonSource.ts";

const NOW = 1_800_000_000_000;
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface Descriptor {
  readonly path: string;
  readonly contents: string;
}

function descriptor(instanceId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    instanceId,
    displayName: `${instanceId} Business OS`,
    status: "running",
    lastSeenAt: NOW - 1_000,
    ...overrides,
  });
}

/** Runs discovery against a real temporary state root. */
function withStateRoot<A>(
  descriptors: readonly Descriptor[],
  use: (input: {
    readonly stateRoot: string;
    readonly discover: (
      options?: CtoxLocalDaemonDiscoveryOptions,
    ) => Effect.Effect<
      readonly CtoxLocalDaemonInstance[],
      never,
      FileSystem.FileSystem | Path.Path
    >;
  }) => Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>,
): Effect.Effect<A> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ctox-local-daemon-test-" });
    const stateRoot = path.join(home, ".local", "state", "ctox");
    for (const entry of descriptors) {
      const filePath = path.join(stateRoot, entry.path);
      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fileSystem.writeFileString(filePath, entry.contents);
    }
    return yield* use({
      stateRoot,
      discover: (options = {}) =>
        discoverCtoxLocalDaemonInstances({
          homeDirectory: home,
          env: {},
          nowEpochMs: () => NOW,
          ...options,
        }),
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.orDie);
}

describe("CtoxLocalDaemonSource", () => {
  it.effect("discovers the root and per-instance descriptors below the default state root", () =>
    withStateRoot(
      [
        { path: "instance.json", contents: descriptor("primary") },
        { path: "instances/alpha/instance.json", contents: descriptor("alpha") },
        {
          path: "instances/beta/instance.json",
          contents: descriptor("beta", { status: "stopped" }),
        },
      ],
      ({ discover }) =>
        Effect.gen(function* () {
          const discovered = yield* discover();
          assert.deepEqual(
            discovered.map((entry) => entry.instance.displayName),
            ["primary Business OS", "alpha Business OS", "beta Business OS"],
          );
          assert.deepEqual(
            discovered.map((entry) => entry.runtimeStatus),
            ["running", "running", "stopped"],
          );
          assert.deepEqual(
            discovered.map((entry) => entry.instance.status),
            ["available", "available", "offline"],
          );
          for (const entry of discovered) {
            assert.equal(entry.instance.source, "local_daemon");
            assert.match(entry.instance.id, /^local:[A-Za-z0-9_-]{22}$/);
            assert.deepEqual(entry.instance.healthSummary, {
              dataPlane: "rxdb-webrtc",
              dataPlaneReady: false,
              httpDataProxy: false,
              nativePeerObserved: false,
            });
            assert.isUndefined(entry.instance.domain);
            assert.isUndefined(entry.instance.role);
            assert.equal(entry.lastSeenAt, NOW - 1_000);
          }
          assert.equal(new Set(discovered.map((entry) => entry.instance.id)).size, 3);

          // The renderer-safe result never carries the state-root path.
          assert.notInclude(encodeUnknownJson(discovered), ".local/state/ctox");
          // Ids are derived from the descriptor path only, so they are stable.
          assert.deepEqual(
            (yield* discover()).map((entry) => entry.instance.id),
            discovered.map((entry) => entry.instance.id),
          );
        }),
    ),
  );

  it.effect("derives a display name from the instance directory when none is declared", () =>
    withStateRoot(
      [
        {
          path: "instances/warehouse/instance.json",
          contents: JSON.stringify({ version: 1, instanceId: "warehouse-1" }),
        },
      ],
      ({ discover }) =>
        Effect.gen(function* () {
          const discovered = yield* discover();
          assert.equal(discovered.length, 1);
          assert.equal(discovered[0]?.instance.displayName, "warehouse (local)");
          // No status and no health endpoint stays unknown and non-available.
          assert.equal(discovered[0]?.runtimeStatus, "unknown");
          assert.equal(discovered[0]?.instance.status, "offline");
          assert.isUndefined(discovered[0]?.lastSeenAt);
        }),
    ),
  );

  it.effect("downgrades a stale self-declared running daemon to unknown", () =>
    withStateRoot(
      [{ path: "instance.json", contents: descriptor("stale", { lastSeenAt: NOW - 600_000 }) }],
      ({ discover }) =>
        Effect.gen(function* () {
          const discovered = yield* discover();
          assert.equal(discovered[0]?.runtimeStatus, "unknown");
          assert.equal(discovered[0]?.instance.status, "offline");
        }),
    ),
  );

  it.effect("treats corrupt, oversized, and unexpected descriptors as not discovered", () =>
    withStateRoot(
      [
        { path: "instance.json", contents: "{not json" },
        {
          path: "instances/a/instance.json",
          contents: JSON.stringify({ version: 2, instanceId: "a" }),
        },
        { path: "instances/b/instance.json", contents: JSON.stringify({ version: 1 }) },
        {
          path: "instances/c/instance.json",
          // An excess key — including anything secret-bearing — is rejected.
          contents: descriptor("c", { roomSecret: "raw-room-secret" }),
        },
        {
          path: "instances/d/instance.json",
          contents: descriptor("d", { instanceId: "../escape" }),
        },
        {
          path: "instances/e/instance.json",
          contents: descriptor("e", { displayName: "control\u0001character" }),
        },
        {
          path: "instances/f/instance.json",
          contents: JSON.stringify({
            version: 1,
            instanceId: "f",
            displayName: "x".repeat(70_000),
          }),
        },
      ],
      ({ discover }) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* discover(), []);
        }),
    ),
  );

  it.effect("returns nothing when the state root is absent or not resolvable", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* discoverCtoxLocalDaemonInstances({
          homeDirectory: "/nonexistent-home-for-ctox-local-daemon-test",
          env: {},
          nowEpochMs: () => NOW,
        }),
        [],
      );
      assert.deepEqual(
        yield* discoverCtoxLocalDaemonInstances({ env: {}, nowEpochMs: () => NOW }),
        [],
      );
      assert.deepEqual(
        yield* discoverCtoxLocalDaemonInstances({
          homeDirectory: "relative/home",
          env: {},
          nowEpochMs: () => NOW,
        }),
        [],
      );
      assert.deepEqual(
        yield* discoverCtoxLocalDaemonInstances({
          homeDirectory: "/home/user",
          env: { CTOX_STATE_ROOT: "relative/state" },
          nowEpochMs: () => NOW,
        }),
        [],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
  );

  it.effect("honours the CTOX_STATE_ROOT override", () =>
    withStateRoot(
      [{ path: "instance.json", contents: descriptor("override") }],
      ({ stateRoot, discover }) =>
        Effect.gen(function* () {
          // The default root of this unrelated home holds nothing.
          assert.deepEqual(
            yield* discover({ homeDirectory: "/nonexistent-home-for-ctox-local-daemon-test" }),
            [],
          );
          const discovered = yield* discover({
            homeDirectory: "/nonexistent-home-for-ctox-local-daemon-test",
            env: { CTOX_STATE_ROOT: `  ${stateRoot}  ` },
          });
          assert.equal(discovered.length, 1);
          assert.equal(discovered[0]?.instance.displayName, "override Business OS");
        }),
    ),
  );

  it.effect("resolves the declared loopback health endpoint through the injected probe", () =>
    withStateRoot(
      [
        {
          path: "instance.json",
          contents: descriptor("probed", {
            status: "stopped",
            healthUrl: "http://127.0.0.1:8899/health",
          }),
        },
      ],
      ({ discover }) =>
        Effect.gen(function* () {
          const probed: string[] = [];
          const healthy = yield* discover({
            probe: (url) => {
              probed.push(url);
              return Promise.resolve({ ok: true });
            },
          });
          assert.deepEqual(probed, ["http://127.0.0.1:8899/health"]);
          assert.equal(healthy[0]?.runtimeStatus, "running");
          assert.equal(healthy[0]?.instance.status, "available");

          const rejected = yield* discover({ probe: () => Promise.reject(new Error("refused")) });
          assert.equal(rejected[0]?.runtimeStatus, "stopped");

          // Without a probe the descriptor's own claim is used.
          assert.equal((yield* discover())[0]?.runtimeStatus, "stopped");
        }),
    ),
  );

  it.effect("never contacts a non-loopback health endpoint", () =>
    withStateRoot(
      [
        {
          path: "instance.json",
          contents: descriptor("remote", { healthUrl: "http://example.com/health" }),
        },
      ],
      ({ discover }) =>
        Effect.gen(function* () {
          const probed: string[] = [];
          const discovered = yield* discover({
            probe: (url) => {
              probed.push(url);
              return Promise.resolve({ ok: true });
            },
          });
          assert.deepEqual(probed, []);
          assert.equal(discovered[0]?.runtimeStatus, "running");
        }),
    ),
  );

  it.effect("caps the number of discovered local instances", () =>
    withStateRoot(
      Array.from({ length: 9 }, (_unused, index) => ({
        path: `instances/i${index}/instance.json`,
        contents: descriptor(`i${index}`),
      })),
      ({ discover }) =>
        Effect.gen(function* () {
          assert.equal((yield* discover()).length, 4);
        }),
    ),
  );

  it("accepts only credential-free loopback health URLs", () => {
    assert.equal(
      normalizeCtoxLocalDaemonHealthUrl("http://localhost:7777/health"),
      "http://localhost:7777/health",
    );
    assert.equal(
      normalizeCtoxLocalDaemonHealthUrl("https://127.0.0.1/health"),
      "https://127.0.0.1/health",
    );
    for (const rejected of [
      "http://example.com/health",
      "http://10.0.0.1/health",
      "ws://127.0.0.1/health",
      "file:///etc/passwd",
      "http://user:pass@127.0.0.1/health",
      "http://127.0.0.1/health?token=abc",
      "http://127.0.0.1/health#fragment",
      "not a url",
    ]) {
      assert.isUndefined(normalizeCtoxLocalDaemonHealthUrl(rejected), rejected);
    }
  });

  it("derives distinct stable ids from the descriptor path", () => {
    const first = ctoxLocalDaemonInstanceId("/home/user/.local/state/ctox/instance.json");
    assert.equal(first, ctoxLocalDaemonInstanceId("/home/user/.local/state/ctox/instance.json"));
    assert.notEqual(
      first,
      ctoxLocalDaemonInstanceId("/home/user/.local/state/ctox/instances/a/instance.json"),
    );
    assert.match(first, /^local:[A-Za-z0-9_-]{22}$/);
  });
});
