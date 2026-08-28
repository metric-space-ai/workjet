// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { CtoxBusinessOsLaunchConfig } from "./CtoxBusinessOsShell.ts";
import * as CtoxInstanceRegistry from "./CtoxInstanceRegistry.ts";
import { buildCtoxBusinessOsLaunchConfig } from "./CtoxLaunchConfig.ts";

/**
 * Launch resolution for CTOX daemons running on this machine.
 *
 * Discovery lists a local daemon read-only; launching one needs pairing
 * material, and the daemon already has a first-class way to hand it over: the
 * same `ctox business-os desktop invite` document the manual invite import
 * accepts. So this service mints one per activation by running the CLI
 * read-only, validates it with the registry's one invite decoder, and packs it
 * into the shared Business OS launch config.
 *
 * Deliberate properties:
 *  - The invite lives only inside one activation. Nothing here writes to the
 *    registry, so a local daemon never leaves room, secret, or capability
 *    material behind on disk, and a revoked daemon is revoked immediately.
 *  - Nothing is logged from the CLI. stdout may be the invite itself and stderr
 *    may quote paths or tokens, so both are reduced to a bounded reason code.
 *  - The binary is resolved exactly like the server-side mailbox transport
 *    does: `CTOX_BIN` when set, otherwise `ctox` on PATH. One convention.
 */

/** Same environment variable the server mailbox transport uses. */
export const CTOX_BIN_ENV = "CTOX_BIN";
const DEFAULT_CTOX_COMMAND = "ctox";
/** A desktop session should outlive a working day without re-minting. */
const INVITE_TTL_HOURS = "24";
/** A wedged daemon must not stall an activation. */
const INVITE_TIMEOUT = Duration.seconds(20);
/**
 * The invite decoder rejects anything above 64 KiB; refuse to even buffer more
 * than a small multiple of that from a chatty binary.
 */
const MAX_INVITE_OUTPUT_BYTES = 262_144;

export const CtoxLocalDaemonLaunchFailureReason = Schema.Literals([
  "not_found",
  "cli_unavailable",
  "cli_timeout",
  "cli_failed",
  "invalid_invite",
  "identity_mismatch",
]);
export type CtoxLocalDaemonLaunchFailureReason = typeof CtoxLocalDaemonLaunchFailureReason.Type;

/**
 * A bounded reason and nothing else: no stderr, no path, no exit text. The code
 * is main-process diagnostics only; the renderer sees the generic guest
 * failure the paired path already uses.
 */
export class CtoxLocalDaemonLaunchError extends Schema.TaggedErrorClass<CtoxLocalDaemonLaunchError>()(
  "CtoxLocalDaemonLaunchError",
  { reason: CtoxLocalDaemonLaunchFailureReason },
) {
  override get message(): string {
    return "The local CTOX daemon could not be prepared for launch.";
  }
}

export interface CtoxLocalDaemonLaunchDescriptor {
  readonly descriptor: CtoxInstanceRegistry.CtoxLocalDaemonTarget["descriptor"];
  readonly config: CtoxBusinessOsLaunchConfig;
}

export class CtoxLocalDaemonLaunch extends Context.Service<
  CtoxLocalDaemonLaunch,
  {
    /**
     * Main-process-only launch resolution. The result carries live pairing
     * material and must never cross IPC or be persisted.
     */
    readonly resolveLaunch: (
      instanceId: string,
    ) => Effect.Effect<CtoxLocalDaemonLaunchDescriptor, CtoxLocalDaemonLaunchError>;
  }
>()("@t3tools/desktop/ctox/CtoxLocalDaemonLaunch") {}

export interface CtoxLocalDaemonLaunchOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nowEpochMs?: () => number;
}

function launchError(reason: CtoxLocalDaemonLaunchFailureReason): CtoxLocalDaemonLaunchError {
  return new CtoxLocalDaemonLaunchError({ reason });
}

export function resolveCtoxBinary(env: Readonly<Record<string, string | undefined>>): string {
  const override = env[CTOX_BIN_ENV]?.trim();
  return override !== undefined && override.length > 0 ? override : DEFAULT_CTOX_COMMAND;
}

/** Read-only invite mint. Nothing in the argument vector is caller-supplied. */
export const CTOX_INVITE_ARGUMENTS: readonly string[] = [
  "business-os",
  "desktop",
  "invite",
  "--format",
  "json",
  "--ttl-hours",
  INVITE_TTL_HOURS,
];

/** Folds a child stream to text, refusing to buffer past the cap. */
function collectBounded<E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> {
  return stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulated, chunk) =>
        accumulated.length > MAX_INVITE_OUTPUT_BYTES ? accumulated : accumulated + chunk,
    ),
  );
}

const runInviteCli = Effect.fn("CtoxLocalDaemonLaunch.runInviteCli")(function* (input: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly command: string;
}) {
  const collected = yield* Effect.gen(function* () {
    const child = yield* input.spawner
      .spawn(ChildProcess.make(input.command, [...CTOX_INVITE_ARGUMENTS]))
      .pipe(Effect.mapError(() => launchError("cli_unavailable")));
    const [stdout, , exitCode] = yield* Effect.all(
      [
        collectBounded(child.stdout),
        // stderr is drained so the child cannot block on a full pipe; its text
        // is never read, kept, or logged.
        collectBounded(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError(() => launchError("cli_failed")));
    return { stdout, exitCode };
  }).pipe(
    Effect.scoped,
    Effect.timeout(INVITE_TIMEOUT),
    Effect.catchTag("TimeoutError", () => Effect.fail(launchError("cli_timeout"))),
  );

  if (collected.exitCode !== 0) return yield* launchError("cli_failed");
  if (collected.stdout.length > MAX_INVITE_OUTPUT_BYTES) {
    return yield* launchError("invalid_invite");
  }
  return collected.stdout;
});

export const make = Effect.fn("CtoxLocalDaemonLaunch.make")(function* (
  options: CtoxLocalDaemonLaunchOptions = {},
) {
  const registry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = options.env ?? process.env;
  const currentTimeMillis =
    options.nowEpochMs === undefined
      ? DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
      : Effect.sync(options.nowEpochMs);

  const resolveLaunch = Effect.fn("CtoxLocalDaemonLaunch.resolveLaunch")(function* (
    instanceId: string,
  ) {
    const target = yield* registry
      .resolveLocalDaemonTarget(instanceId)
      .pipe(Effect.mapError(() => launchError("not_found")));

    const invite = yield* runInviteCli({ spawner, command: resolveCtoxBinary(env) });
    const now = yield* currentTimeMillis;
    const pairing = yield* CtoxInstanceRegistry.parseCtoxPairingInvite(invite, now).pipe(
      Effect.mapError(() => launchError("invalid_invite")),
    );

    // One state root can host several daemons while the CLI answers for only
    // one of them. Unless the machine has exactly one daemon, the invite must
    // name the daemon the user picked — otherwise this would silently open a
    // different workspace than the row that was clicked.
    if (target.discoveredCount > 1 && pairing.instanceIdentity !== target.daemonInstanceId) {
      return yield* launchError("identity_mismatch");
    }

    const user =
      pairing.userId === undefined &&
      pairing.userDisplayName === undefined &&
      pairing.role === undefined
        ? undefined
        : {
            ...(pairing.userId === undefined ? {} : { id: pairing.userId }),
            ...(pairing.userDisplayName === undefined
              ? {}
              : { displayName: pairing.userDisplayName }),
            ...(pairing.role === undefined ? {} : { role: pairing.role }),
          };

    return {
      descriptor: target.descriptor,
      config: buildCtoxBusinessOsLaunchConfig({
        instanceId: target.descriptor.id,
        displayName: target.descriptor.displayName,
        source: "local_daemon",
        material: {
          syncRoom: pairing.syncRoom,
          signalingUrls: pairing.signalingUrls,
          signalingAuthVersion: pairing.signalingAuthVersion,
          browserToken: pairing.browserToken,
          browserTokenHash: pairing.browserTokenHash,
          nativeTokenHash: pairing.nativeTokenHash,
          ...(pairing.capabilityToken === undefined
            ? {}
            : { capabilityToken: pairing.capabilityToken }),
          ...(pairing.capabilityExpiresAtMs === undefined
            ? {}
            : { capabilityExpiresAtMs: pairing.capabilityExpiresAtMs }),
          ...(user === undefined ? {} : { user }),
        },
      }),
    };
  });

  return CtoxLocalDaemonLaunch.of({ resolveLaunch });
});

export const layer = (options: CtoxLocalDaemonLaunchOptions = {}) =>
  Layer.effect(CtoxLocalDaemonLaunch, make(options));
