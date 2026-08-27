// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, describe, it } from "@effect/vitest";
import type { CtoxManagedInstance } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as CtoxInstanceRegistry from "./CtoxInstanceRegistry.ts";
import * as CtoxSshManagedLaunch from "./CtoxSshManagedLaunch.ts";
import {
  buildCtoxSshInviteCommand,
  CTOX_SSH_INVITE_FAILURE_MARKER,
} from "./CtoxSshManagedSource.ts";

const NOW = 1_800_000_000_000;
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const sshDescriptor: CtoxManagedInstance = {
  id: "ssh:AAAAAAAAAAAAAAAAAAAAAA",
  source: "ssh_managed",
  displayName: "Build Box",
  status: "available",
  healthSummary: {
    dataPlane: "rxdb-webrtc",
    dataPlaneReady: false,
    httpDataProxy: false,
    nativePeerObserved: false,
  },
};

function inviteJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "ctox-business-os-invite",
    version: 1,
    display_name: "Build Box Business OS",
    instance_id: "buildbox-1",
    sync_room: "ctox-business-os:buildbox-room",
    signaling_urls: ["ws://127.0.0.1:4444/signal"],
    signaling_room_password: "raw-remote-secret",
    transport: "webrtc",
    expires_at_ms: NOW + 86_400_000,
    data_plane: "rxdb-webrtc",
    session: {
      authenticated: true,
      source: "desktop_invite",
      capability_token: "raw-remote-capability",
      capability_expires_at_ms: NOW + 86_400_000,
      user: { id: "private-user-id", display_name: "Private User", role: "chef" },
    },
    ...overrides,
  });
}

function registryStub(
  input: { readonly found?: boolean; readonly stateRoot?: string } = {},
): Layer.Layer<CtoxInstanceRegistry.CtoxInstanceRegistry> {
  return Layer.succeed(
    CtoxInstanceRegistry.CtoxInstanceRegistry,
    CtoxInstanceRegistry.CtoxInstanceRegistry.of({
      merge: () => Effect.die("unused"),
      importInvite: () => Effect.die("unused"),
      importManualPairing: () => Effect.die("unused"),
      removePairedInstance: () => Effect.die("unused"),
      addSshManagedInstance: () => Effect.die("unused"),
      removeSshManagedInstance: () => Effect.die("unused"),
      resolvePairedLaunch: () => Effect.die("unused"),
      resolveLocalDaemonTarget: () => Effect.die("unused"),
      stableIdentityKey: () => Effect.die("unused"),
      resolveBusinessOsInstanceId: () => Effect.die("unused"),
      resolveSshManagedTarget: (instanceId) =>
        input.found !== false && instanceId === sshDescriptor.id
          ? Effect.succeed({
              descriptor: sshDescriptor,
              host: "buildbox",
              ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }),
            })
          : Effect.fail(new CtoxInstanceRegistry.CtoxInstanceRegistryError({ code: "not_found" })),
    }),
  );
}

interface HarnessOptions {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly execFails?: boolean;
  readonly forwardFails?: boolean;
  readonly stateRoot?: string;
  readonly found?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const execCalls: Array<{ host: string; argv: readonly string[] }> = [];
  const forwardCalls: Array<{ host: string; remotePort: number }> = [];
  let openForwards = 0;
  let closedForwards = 0;
  let nextLocalPort = 52_001;

  const exec: CtoxSshManagedLaunch.CtoxSshInviteExec = (input) => {
    execCalls.push({ host: input.host, argv: input.argv });
    return options.execFails === true
      ? Effect.fail(
          new CtoxSshManagedLaunch.CtoxSshManagedLaunchError({ reason: "invite_unreachable" }),
        )
      : Effect.succeed({
          stdout: options.stdout ?? inviteJson(),
          ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
        });
  };

  const openForward: CtoxSshManagedLaunch.CtoxSshForwardOpener = (input) =>
    Effect.gen(function* () {
      forwardCalls.push({ host: input.host, remotePort: input.remotePort });
      if (options.forwardFails === true) {
        return yield* new CtoxSshManagedLaunch.CtoxSshManagedLaunchError({
          reason: "forward_failed",
        });
      }
      const localPort = nextLocalPort;
      nextLocalPort += 1;
      openForwards += 1;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closedForwards += 1;
        }),
      );
      return { localPort };
    });

  const layer = CtoxSshManagedLaunch.layer({
    exec,
    openForward,
    nowEpochMs: () => NOW,
  }).pipe(
    Layer.provide(
      registryStub({
        ...(options.found === undefined ? {} : { found: options.found }),
        ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
      }),
    ),
  );

  return {
    layer,
    execCalls,
    forwardCalls,
    counts: () => ({ open: openForwards, closed: closedForwards }),
  };
}

describe("extractCtoxSshRemoteSignalingPorts", () => {
  it("reads the distinct remote loopback ports in first-seen order", () => {
    assert.deepEqual(
      CtoxSshManagedLaunch.extractCtoxSshRemoteSignalingPorts([
        "ws://127.0.0.1:4444/signal",
        "ws://localhost:5555/signal",
        "ws://127.0.0.1:4444/other",
      ]),
      [4_444, 5_555],
    );
  });

  it("rejects endpoints that no local forward could stand in for", () => {
    for (const urls of [
      [],
      // A public endpoint reached over TLS is not forwardable, and passing it
      // through would send room material somewhere the user never approved.
      ["wss://signal.example.com/room"],
      ["ws://signal.example.com:4444/room"],
      // 10.0.0.1 is private but not loopback: still the wrong side of the tunnel.
      ["ws://10.0.0.1:4444/room"],
      ["ws://127.0.0.1/signal"],
      ["ws://127.0.0.1:0/signal"],
      ["ws://127.0.0.1:70000/signal"],
      ["not a url"],
      ["ws://127.0.0.1:4444/a", "wss://signal.example.com/b"],
      // More distinct ports than one daemon has any reason to publish.
      [
        "ws://127.0.0.1:1/a",
        "ws://127.0.0.1:2/b",
        "ws://127.0.0.1:3/c",
        "ws://127.0.0.1:4/d",
        "ws://127.0.0.1:5/e",
      ],
    ]) {
      assert.isUndefined(
        CtoxSshManagedLaunch.extractCtoxSshRemoteSignalingPorts(urls),
        `expected rejection for ${JSON.stringify(urls)}`,
      );
    }
  });
});

describe("rewriteCtoxSshSignalingUrls", () => {
  it("pins every endpoint to its forwarded local port and keeps the path", () => {
    assert.deepEqual(
      CtoxSshManagedLaunch.rewriteCtoxSshSignalingUrls(
        ["ws://127.0.0.1:4444/signal", "ws://localhost:5555/other"],
        new Map([
          [4_444, 52_001],
          [5_555, 52_002],
        ]),
      ),
      ["ws://127.0.0.1:52001/signal", "ws://127.0.0.1:52002/other"],
    );
  });

  it("refuses to rewrite a port that was never forwarded", () => {
    assert.isUndefined(
      CtoxSshManagedLaunch.rewriteCtoxSshSignalingUrls(
        ["ws://127.0.0.1:4444/signal", "ws://127.0.0.1:9999/signal"],
        new Map([[4_444, 52_001]]),
      ),
    );
    assert.isUndefined(
      CtoxSshManagedLaunch.rewriteCtoxSshSignalingUrls(
        ["ws://127.0.0.1:4444/signal"],
        new Map([[4_444, 70_000]]),
      ),
    );
  });
});

describe("buildCtoxSshInviteCommand", () => {
  it("is a fixed script that bounds its own output and honours CTOX_BIN", () => {
    const [shell, flag, script] = buildCtoxSshInviteCommand();
    assert.equal(shell, "sh");
    assert.equal(flag, "-c");
    assert.include(script, 'CTOX_ROOT="${CTOX_STATE_ROOT:-$HOME/.local/state/ctox}"');
    assert.include(script, 'export CTOX_STATE_ROOT="$CTOX_ROOT"');
    assert.include(script, '"${CTOX_BIN:-ctox}" business-os desktop invite --format json');
    assert.include(script, "--ttl-hours 24");
    assert.include(script, "head -c 262144");
    assert.include(script, CTOX_SSH_INVITE_FAILURE_MARKER);
  });

  it("POSIX-quotes a configured state root so it cannot escape its argument", () => {
    const script = buildCtoxSshInviteCommand("/srv/ctox'; rm -rf /")[2] ?? "";
    assert.include(script, `CTOX_ROOT='/srv/ctox'\\''; rm -rf /'`);
    assert.notInclude(script, "; rm -rf /;");
  });
});

describe("CtoxSshManagedLaunch", () => {
  it.effect("mints, forwards, and rewrites the invite onto local ports", () => {
    const test = harness({ stateRoot: "/srv/ctox" });
    return Effect.gen(function* () {
      const launch = yield* CtoxSshManagedLaunch.CtoxSshManagedLaunch;
      const resolved = yield* launch.resolveLaunch(sshDescriptor.id);

      assert.equal(resolved.descriptor.id, sshDescriptor.id);
      assert.deepEqual(test.forwardCalls, [{ host: "buildbox", remotePort: 4_444 }]);
      assert.deepEqual(resolved.config.signaling_urls, ["ws://127.0.0.1:52001/signal"]);
      assert.equal(resolved.config.desktop_instance.source, "ssh_managed");
      assert.equal(resolved.config.desktop_instance.id, sshDescriptor.id);
      assert.equal(resolved.config.http_bridge_available, false);
      assert.equal(resolved.config.signaling_room_password, "raw-remote-secret");
      assert.equal(resolved.config.session?.user?.is_admin, true);

      // The remote loopback port never survives into the packed config.
      assert.notInclude(encodeUnknownJson(resolved.config.signaling_urls), "4444");
      // The invite is minted in the configured state root.
      assert.equal(test.execCalls.length, 1);
      assert.include(test.execCalls[0]?.argv[2] ?? "", "CTOX_ROOT='/srv/ctox'");

      assert.deepEqual(test.counts(), { open: 1, closed: 0 });
      yield* resolved.closeForwards;
      assert.deepEqual(test.counts(), { open: 1, closed: 1 });
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("opens one forward per distinct remote signaling port", () => {
    const test = harness({
      stdout: inviteJson({
        signaling_urls: [
          "ws://127.0.0.1:4444/signal",
          "ws://127.0.0.1:5555/signal",
          "ws://127.0.0.1:4444/alt",
        ],
      }),
    });
    return Effect.gen(function* () {
      const launch = yield* CtoxSshManagedLaunch.CtoxSshManagedLaunch;
      const resolved = yield* launch.resolveLaunch(sshDescriptor.id);
      assert.deepEqual(test.forwardCalls, [
        { host: "buildbox", remotePort: 4_444 },
        { host: "buildbox", remotePort: 5_555 },
      ]);
      assert.deepEqual(resolved.config.signaling_urls, [
        "ws://127.0.0.1:52001/alt",
        "ws://127.0.0.1:52001/signal",
        "ws://127.0.0.1:52002/signal",
      ]);
      yield* resolved.closeForwards;
      assert.deepEqual(test.counts(), { open: 2, closed: 2 });
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("fails with not_found for an unknown or unlaunchable instance", () => {
    const test = harness({ found: false });
    return Effect.gen(function* () {
      const launch = yield* CtoxSshManagedLaunch.CtoxSshManagedLaunch;
      const error = yield* launch.resolveLaunch(sshDescriptor.id).pipe(Effect.flip);
      assert.equal(error.reason, "not_found");
      assert.equal(test.execCalls.length, 0);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("fails with invite_unreachable when the SSH command itself fails", () => {
    const test = harness({ execFails: true });
    return Effect.gen(function* () {
      const launch = yield* CtoxSshManagedLaunch.CtoxSshManagedLaunch;
      const error = yield* launch.resolveLaunch(sshDescriptor.id).pipe(Effect.flip);
      assert.equal(error.reason, "invite_unreachable");
      assert.deepEqual(test.counts(), { open: 0, closed: 0 });
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("fails with invite_failed when the remote CLI announces its own failure", () => {
    // `head` masks the CLI's exit status, so the marker on stderr is the only
    // way to tell a failed mint from an empty one.
    const test = harness({ stdout: "", stderr: `${CTOX_SSH_INVITE_FAILURE_MARKER}\n` });
    return Effect.gen(function* () {
      const launch = yield* CtoxSshManagedLaunch.CtoxSshManagedLaunch;
      const error = yield* launch.resolveLaunch(sshDescriptor.id).pipe(Effect.flip);
      assert.equal(error.reason, "invite_failed");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("fails with invite_failed on empty remote output", () => {
    const test = harness({ stdout: "   \n" });
    return Effect.gen(function* () {
      const launch = yield* CtoxSshManagedLaunch.CtoxSshManagedLaunch;
      const error = yield* launch.resolveLaunch(sshDescriptor.id).pipe(Effect.flip);
      assert.equal(error.reason, "invite_failed");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("fails with invalid_invite on unparseable or oversized output", () => {
    return Effect.gen(function* () {
      for (const stdout of ["not json at all", inviteJson({ version: 2 }), "x".repeat(300_000)]) {
        const test = harness({ stdout });
        const error = yield* Effect.gen(function* () {
          const launch = yield* CtoxSshManagedLaunch.CtoxSshManagedLaunch;
          return yield* launch.resolveLaunch(sshDescriptor.id).pipe(Effect.flip);
        }).pipe(Effect.provide(test.layer));
        assert.equal(error.reason, "invalid_invite");
        assert.deepEqual(test.counts(), { open: 0, closed: 0 });
      }
    });
  });

  it.effect("fails with unsupported_signaling for a non-forwardable endpoint", () => {
    // A `wss://` endpoint passes the registry decoder but cannot be reached
    // through an `-L` forward, so the launch refuses rather than leaking it.
    const test = harness({
      stdout: inviteJson({ signaling_urls: ["wss://signal.example.com/room"] }),
    });
    return Effect.gen(function* () {
      const launch = yield* CtoxSshManagedLaunch.CtoxSshManagedLaunch;
      const error = yield* launch.resolveLaunch(sshDescriptor.id).pipe(Effect.flip);
      assert.equal(error.reason, "unsupported_signaling");
      assert.deepEqual(test.counts(), { open: 0, closed: 0 });
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("fails with forward_failed and leaves no forward open", () => {
    const test = harness({
      forwardFails: true,
      stdout: inviteJson({
        signaling_urls: ["ws://127.0.0.1:4444/signal", "ws://127.0.0.1:5555/signal"],
      }),
    });
    return Effect.gen(function* () {
      const launch = yield* CtoxSshManagedLaunch.CtoxSshManagedLaunch;
      const error = yield* launch.resolveLaunch(sshDescriptor.id).pipe(Effect.flip);
      assert.equal(error.reason, "forward_failed");
      assert.deepEqual(test.counts(), { open: 0, closed: 0 });
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("closes an already-open forward when a later one fails", () => {
    let attempt = 0;
    let opened = 0;
    let closed = 0;
    const openForward: CtoxSshManagedLaunch.CtoxSshForwardOpener = (_input) =>
      Effect.gen(function* () {
        attempt += 1;
        if (attempt > 1) {
          return yield* new CtoxSshManagedLaunch.CtoxSshManagedLaunchError({
            reason: "forward_failed",
          });
        }
        opened += 1;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed += 1;
          }),
        );
        return { localPort: 52_001 };
      });
    const layer = CtoxSshManagedLaunch.layer({
      exec: () =>
        Effect.succeed({
          stdout: inviteJson({
            signaling_urls: ["ws://127.0.0.1:4444/a", "ws://127.0.0.1:5555/b"],
          }),
        }),
      openForward,
      nowEpochMs: () => NOW,
    }).pipe(Layer.provide(registryStub()));

    return Effect.gen(function* () {
      const launch = yield* CtoxSshManagedLaunch.CtoxSshManagedLaunch;
      const error = yield* launch.resolveLaunch(sshDescriptor.id).pipe(Effect.flip);
      assert.equal(error.reason, "forward_failed");
      // The first tunnel must not survive the failed second one.
      assert.equal(opened, 1);
      assert.equal(closed, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails closed when no SSH services are available at all", () => {
    // Without a spawner there is no SSH path; a launch may not pretend
    // otherwise, so the default exec fails instead of the forward silently
    // pointing at the desktop's own loopback.
    const layer = CtoxSshManagedLaunch.layer().pipe(Layer.provide(registryStub()));
    return Effect.gen(function* () {
      const launch = yield* CtoxSshManagedLaunch.CtoxSshManagedLaunch;
      const error = yield* launch.resolveLaunch(sshDescriptor.id).pipe(Effect.flip);
      assert.equal(error.reason, "invite_unreachable");
    }).pipe(Effect.provide(layer));
  });
});
