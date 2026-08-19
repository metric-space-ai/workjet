// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { runSshCommand } from "@t3tools/ssh/command";
import { openSshLocalForward } from "@t3tools/ssh/localForward";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as NetService from "@t3tools/shared/Net";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { CtoxBusinessOsLaunchConfig } from "./CtoxBusinessOsShell.ts";
import * as CtoxInstanceRegistry from "./CtoxInstanceRegistry.ts";
import { buildCtoxBusinessOsLaunchConfig } from "./CtoxLaunchConfig.ts";
import {
  buildCtoxSshInviteCommand,
  CTOX_SSH_INVITE_FAILURE_MARKER,
  CTOX_SSH_INVITE_TIMEOUT_MS,
  MAX_CTOX_SSH_INVITE_BYTES,
} from "./CtoxSshManagedSource.ts";

/**
 * Launch resolution for CTOX daemons on SSH hosts.
 *
 * This is the local-daemon flow with one extra hop. A daemon hands out pairing
 * material through `ctox business-os desktop invite`, so the invite is minted
 * per activation here too — over `runSshCommand`, the desktop's one SSH
 * execution path, with the same argv-not-shell construction, `BatchMode=yes`,
 * and unweakened host-key policy discovery already uses.
 *
 * The extra hop is reachability. A remote invite names its signaling endpoints
 * on the *remote* loopback interface (`ws://127.0.0.1:PORT`); handing those to
 * a guest would point it at the desktop's own loopback instead. So each
 * distinct remote signaling port gets an `ssh -L` forward from
 * `@t3tools/ssh/localForward`, and the invite's URLs are rewritten onto the
 * local ends before anything sees them.
 *
 * Deliberate properties:
 *  - Fail-closed at every step. A failed mint, an unparseable invite, a
 *    signaling URL that is not remote loopback, or a forward that never becomes
 *    ready all end as one bounded reason and no forwards left open. There is no
 *    half-open state where a guest holds URLs to a dead tunnel.
 *  - Only remote-loopback `ws://` endpoints are accepted. A `wss://` or public
 *    endpoint cannot be reached through a `-L` forward, and silently passing it
 *    through would send room material somewhere the user never approved.
 *  - Nothing is persisted or logged: not the invite, not the destination, not
 *    remote stderr. The renderer sees the same generic guest failure the paired
 *    path already uses.
 */

/** One daemon publishes a handful of signaling endpoints, never a fleet. */
const MAX_SIGNALING_FORWARDS = 4;
const MIN_PORT = 1;
const MAX_PORT = 65_535;
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export const CtoxSshManagedLaunchFailureReason = Schema.Literals([
  "not_found",
  "invite_unreachable",
  "invite_failed",
  "invalid_invite",
  "unsupported_signaling",
  "forward_failed",
]);
export type CtoxSshManagedLaunchFailureReason = typeof CtoxSshManagedLaunchFailureReason.Type;

/**
 * A bounded reason and nothing else: no destination, no path, no remote stderr,
 * no exit text. The code is main-process diagnostics only.
 */
export class CtoxSshManagedLaunchError extends Schema.TaggedErrorClass<CtoxSshManagedLaunchError>()(
  "CtoxSshManagedLaunchError",
  { reason: CtoxSshManagedLaunchFailureReason },
) {
  override get message(): string {
    return "The SSH-managed CTOX instance could not be prepared for launch.";
  }
}

function launchError(reason: CtoxSshManagedLaunchFailureReason): CtoxSshManagedLaunchError {
  return new CtoxSshManagedLaunchError({ reason });
}

/**
 * The remote signaling ports named by an invite, in first-seen order.
 *
 * Every URL must be a remote-loopback `ws://` endpoint with an explicit,
 * in-range port; one that is not means the whole invite is unusable through a
 * forward, so the result is `undefined` rather than a partial mapping.
 */
export function extractCtoxSshRemoteSignalingPorts(
  signalingUrls: readonly string[],
): readonly number[] | undefined {
  if (signalingUrls.length === 0) return undefined;
  const ports: number[] = [];
  for (const raw of signalingUrls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    if (url.protocol !== "ws:") return undefined;
    if (!LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())) return undefined;
    // `URL` drops a default port, and ws: has no default worth guessing at.
    const port = Number.parseInt(url.port, 10);
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return undefined;
    if (!ports.includes(port)) ports.push(port);
    if (ports.length > MAX_SIGNALING_FORWARDS) return undefined;
  }
  return ports;
}

/**
 * Rewrites each signaling URL onto its forwarded local port. The path is
 * preserved; the host is pinned to `127.0.0.1` regardless of which loopback
 * spelling the daemon used, so the guest reaches exactly the forward.
 */
export function rewriteCtoxSshSignalingUrls(
  signalingUrls: readonly string[],
  portMapping: ReadonlyMap<number, number>,
): readonly string[] | undefined {
  const rewritten: string[] = [];
  for (const raw of signalingUrls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    const remotePort = Number.parseInt(url.port, 10);
    const localPort = portMapping.get(remotePort);
    if (localPort === undefined || localPort < MIN_PORT || localPort > MAX_PORT) return undefined;
    url.hostname = "127.0.0.1";
    url.port = String(localPort);
    const next = url.toString();
    if (!rewritten.includes(next)) rewritten.push(next);
  }
  return rewritten.length === 0 ? undefined : rewritten;
}

/** A forwarded signaling port. Its lifetime belongs to the caller's scope. */
export interface CtoxSshForward {
  readonly localPort: number;
}

/**
 * Opens one forward inside the ambient scope. Production wraps
 * `openSshLocalForward`; tests supply a fake so neither `ssh` nor a listener is
 * needed.
 */
export type CtoxSshForwardOpener = (input: {
  readonly host: string;
  readonly remotePort: number;
}) => Effect.Effect<CtoxSshForward, CtoxSshManagedLaunchError, Scope.Scope>;

export interface CtoxSshInviteExecInput {
  readonly host: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

export interface CtoxSshInviteExecResult {
  readonly stdout: string;
  readonly stderr?: string;
}

/** The injected SSH execution path for minting the invite. */
export type CtoxSshInviteExec = (
  input: CtoxSshInviteExecInput,
) => Effect.Effect<CtoxSshInviteExecResult, CtoxSshManagedLaunchError>;

export interface CtoxSshManagedLaunchDescriptor {
  readonly descriptor: CtoxInstanceRegistry.CtoxSshManagedTarget["descriptor"];
  readonly config: CtoxBusinessOsLaunchConfig;
  /**
   * Closes every forward opened for this launch. The guest session owns it:
   * tearing the guest down must tear the tunnels down with it, or the desktop
   * would keep an SSH child per abandoned activation.
   */
  readonly closeForwards: Effect.Effect<void>;
}

export class CtoxSshManagedLaunch extends Context.Service<
  CtoxSshManagedLaunch,
  {
    /**
     * Main-process-only launch resolution. The result carries live pairing
     * material and must never cross IPC or be persisted.
     */
    readonly resolveLaunch: (
      instanceId: string,
    ) => Effect.Effect<CtoxSshManagedLaunchDescriptor, CtoxSshManagedLaunchError>;
  }
>()("@t3tools/desktop/ctox/CtoxSshManagedLaunch") {}

export interface CtoxSshManagedLaunchOptions {
  readonly exec?: CtoxSshInviteExec;
  readonly openForward?: CtoxSshForwardOpener;
  readonly nowEpochMs?: () => number;
}

function sshTarget(host: string): DesktopSshEnvironmentTarget {
  return { alias: host, hostname: host, username: null, port: null };
}

/**
 * The production invite mint. `runSshCommand` is reused unchanged, so target
 * resolution, argument-vector construction, authentication helpers, redaction,
 * and host-key behaviour are exactly the desktop's existing SSH semantics.
 */
export function makeCtoxSshInviteExec(services: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): CtoxSshInviteExec {
  return (input) =>
    runSshCommand(sshTarget(input.host), {
      remoteCommandArgs: [...input.argv],
      timeoutMs: input.timeoutMs,
      batchMode: "yes",
    }).pipe(
      Effect.map(
        (result): CtoxSshInviteExecResult => ({ stdout: result.stdout, stderr: result.stderr }),
      ),
      Effect.mapError(() => launchError("invite_unreachable")),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, services.spawner),
      Effect.provideService(FileSystem.FileSystem, services.fileSystem),
      Effect.provideService(Path.Path, services.path),
    );
}

/** The production forward opener, bound to the services captured at construction. */
export function makeCtoxSshForwardOpener(services: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly net: NetService.NetService["Service"];
}): CtoxSshForwardOpener {
  return (input) =>
    openSshLocalForward(sshTarget(input.host), input.remotePort, {
      authOptions: { batchMode: "yes", interactiveAuth: false },
    }).pipe(
      Effect.map((forward): CtoxSshForward => ({ localPort: forward.localPort })),
      Effect.mapError(() => launchError("forward_failed")),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, services.spawner),
      Effect.provideService(FileSystem.FileSystem, services.fileSystem),
      Effect.provideService(Path.Path, services.path),
      Effect.provideService(NetService.NetService, services.net),
    );
}

export const make = Effect.fn("CtoxSshManagedLaunch.make")(function* (
  options: CtoxSshManagedLaunchOptions = {},
) {
  const registry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
  const spawnerOption = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
  const fileSystemOption = yield* Effect.serviceOption(FileSystem.FileSystem);
  const pathOption = yield* Effect.serviceOption(Path.Path);
  const netOption = yield* Effect.serviceOption(NetService.NetService);
  const services =
    spawnerOption._tag === "Some" &&
    fileSystemOption._tag === "Some" &&
    pathOption._tag === "Some" &&
    netOption._tag === "Some"
      ? {
          spawner: spawnerOption.value,
          fileSystem: fileSystemOption.value,
          path: pathOption.value,
          net: netOption.value,
        }
      : undefined;

  // Without the ambient services there is no SSH path at all, so every launch
  // fails closed rather than pretending a forward could be opened.
  const exec: CtoxSshInviteExec =
    options.exec ??
    (services === undefined
      ? () => Effect.fail(launchError("invite_unreachable"))
      : makeCtoxSshInviteExec(services));
  const openForward: CtoxSshForwardOpener =
    options.openForward ??
    (services === undefined
      ? () => Effect.fail(launchError("forward_failed"))
      : makeCtoxSshForwardOpener(services));

  const currentTimeMillis =
    options.nowEpochMs === undefined
      ? DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
      : Effect.sync(options.nowEpochMs);

  const mintInvite = Effect.fn("CtoxSshManagedLaunch.mintInvite")(function* (target: {
    readonly host: string;
    readonly stateRoot?: string;
  }) {
    const result = yield* exec({
      host: target.host,
      argv: buildCtoxSshInviteCommand(target.stateRoot),
      timeoutMs: CTOX_SSH_INVITE_TIMEOUT_MS,
    });
    // The pipeline's exit status is `head`'s, so the CLI announces its own
    // failure on stderr. Only this marker is ever read out of stderr.
    if (result.stderr?.includes(CTOX_SSH_INVITE_FAILURE_MARKER) === true) {
      return yield* launchError("invite_failed");
    }
    if (result.stdout.length > MAX_CTOX_SSH_INVITE_BYTES) {
      return yield* launchError("invalid_invite");
    }
    if (result.stdout.trim().length === 0) return yield* launchError("invite_failed");
    return result.stdout;
  });

  const resolveLaunch = Effect.fn("CtoxSshManagedLaunch.resolveLaunch")(function* (
    instanceId: string,
  ) {
    const target = yield* registry
      .resolveSshManagedTarget(instanceId)
      .pipe(Effect.mapError(() => launchError("not_found")));

    const invite = yield* mintInvite({
      host: target.host,
      ...(target.stateRoot === undefined ? {} : { stateRoot: target.stateRoot }),
    });
    const now = yield* currentTimeMillis;
    // The registry's one invite decoder: same bounds, same normalization, same
    // rejection of an HTTP data bridge as the paired and local paths.
    const pairing = yield* CtoxInstanceRegistry.parseCtoxPairingInvite(invite, now).pipe(
      Effect.mapError(() => launchError("invalid_invite")),
    );

    const remotePorts = extractCtoxSshRemoteSignalingPorts(pairing.signalingUrls);
    if (remotePorts === undefined) return yield* launchError("unsupported_signaling");

    // One scope for every forward of this launch, closed as a unit.
    const forwardScope = yield* Scope.make("sequential");
    const closeForwards = Scope.close(forwardScope, Exit.void).pipe(Effect.ignore);

    const signalingUrls = yield* Effect.gen(function* () {
      const portMapping = new Map<number, number>();
      for (const remotePort of remotePorts) {
        const forward = yield* openForward({ host: target.host, remotePort }).pipe(
          Effect.provideService(Scope.Scope, forwardScope),
        );
        portMapping.set(remotePort, forward.localPort);
      }
      const rewritten = rewriteCtoxSshSignalingUrls(pairing.signalingUrls, portMapping);
      if (rewritten === undefined) return yield* launchError("unsupported_signaling");
      return rewritten;
    }).pipe(
      // Any failure after the first forward opened must not leave a tunnel
      // behind; a half-open launch is the one outcome this path may not have.
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeForwards)),
    );

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
      closeForwards,
      config: buildCtoxBusinessOsLaunchConfig({
        instanceId: target.descriptor.id,
        displayName: target.descriptor.displayName,
        source: "ssh_managed",
        material: {
          syncRoom: pairing.syncRoom,
          signalingUrls,
          roomSecret: pairing.roomSecret,
          ...(pairing.capabilityToken === undefined
            ? {}
            : { capabilityToken: pairing.capabilityToken }),
          ...(pairing.capabilityExpiresAtMs === undefined
            ? {}
            : { capabilityExpiresAtMs: pairing.capabilityExpiresAtMs }),
          ...(user === undefined ? {} : { user }),
        },
      }),
    } satisfies CtoxSshManagedLaunchDescriptor;
  });

  return CtoxSshManagedLaunch.of({ resolveLaunch });
});

export const layer = (options: CtoxSshManagedLaunchOptions = {}) =>
  Layer.effect(CtoxSshManagedLaunch, make(options));
