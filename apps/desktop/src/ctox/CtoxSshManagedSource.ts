// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeCrypto from "node:crypto";

import type {
  CtoxManagedInstance,
  CtoxSshManagedInstanceAddInput,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { runSshCommand } from "@t3tools/ssh/command";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ctoxDaemonDeclaredStatus,
  decodeCtoxDaemonDescriptor,
  MAX_CTOX_DAEMON_DESCRIPTOR_BYTES,
  type CtoxLocalDaemonRuntimeStatus,
} from "./CtoxLocalDaemonSource.ts";

/**
 * Read-only discovery of CTOX daemons on SSH hosts the user has configured.
 *
 * The desktop already owns an SSH execution path — `@t3tools/ssh/command`'s
 * `runSshCommand`, the same one `DesktopSshEnvironment` drives — so this module
 * adds no second SSH stack, no credential storage, and no host-key policy of
 * its own:
 *
 *  - Authentication is whatever the user's own `ssh` already does: agent, keys,
 *    `~/.ssh/config`. Nothing here reads, stores, or forwards a secret.
 *  - Host-key pinning is OpenSSH's own `known_hosts` check. `baseSshArgs` never
 *    weakens `StrictHostKeyChecking`, and discovery runs with `BatchMode=yes`,
 *    so an unknown or changed host key aborts the connection instead of
 *    prompting or auto-accepting.
 *  - The remote command is a fixed script; the only caller-supplied value (the
 *    optional state root) is both schema-restricted to a conservative path
 *    alphabet and POSIX single-quoted before it reaches the remote shell.
 *
 * Discovery cannot fail: an unreachable host, a missing descriptor, or a
 * malformed one all read as "offline", so a broken remote can never break the
 * one shared instance registry.
 */

const CONFIG_VERSION = 1;
/** A workstation manages a handful of hosts, never a fleet. */
const MAX_SSH_INSTANCES = 32;
/** Discovery runs on every refresh, so a wedged host must not stall it. */
const SSH_DESCRIPTOR_TIMEOUT_MS = 8_000;
const SSH_DISCOVERY_CONCURRENCY = 4;

const NoAsciiControlCharacters = Schema.makeFilter((value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return "Control characters are not allowed.";
    }
  }
  return true;
});
const SafeText = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  NoAsciiControlCharacters,
);
const ConfiguredId = SafeText.check(Schema.isPattern(/^ssh:[A-Za-z0-9_-]{22}$/));
const ConfiguredHost = SafeText.check(
  Schema.isMaxLength(255),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/),
);
const ConfiguredStateRoot = SafeText.check(
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^\/[A-Za-z0-9._\-/]{0,1023}$/),
);
const ConfiguredDisplayName = SafeText.check(Schema.isMaxLength(256));

/**
 * One configured SSH-managed instance. This document is public by design: it
 * holds a destination the user already has in their SSH config and nothing
 * else. Credentials live where they already lived — in SSH.
 */
export const CtoxSshManagedConfigEntry = Schema.Struct({
  id: ConfiguredId,
  host: ConfiguredHost,
  displayName: ConfiguredDisplayName,
  stateRoot: Schema.optionalKey(ConfiguredStateRoot),
});
export type CtoxSshManagedConfigEntry = typeof CtoxSshManagedConfigEntry.Type;

export const CtoxSshManagedConfigDocument = Schema.Struct({
  version: Schema.Literal(CONFIG_VERSION),
  instances: Schema.Array(CtoxSshManagedConfigEntry).check(Schema.isMaxLength(MAX_SSH_INSTANCES)),
});
export type CtoxSshManagedConfigDocument = typeof CtoxSshManagedConfigDocument.Type;

export const CtoxSshManagedConfigDocumentJson = Schema.fromJsonString(CtoxSshManagedConfigDocument);

export const CTOX_SSH_MANAGED_CONFIG_VERSION = CONFIG_VERSION;
export const MAX_CTOX_SSH_MANAGED_INSTANCES = MAX_SSH_INSTANCES;

/** Shape of every id this module mints; nothing else may be treated as SSH-managed. */
export const CTOX_SSH_MANAGED_ID_PATTERN = /^ssh:[A-Za-z0-9_-]{22}$/;

/**
 * Stable renderer id of an SSH-managed instance, derived from the destination
 * and state root so it survives restarts while never exposing either.
 */
export function ctoxSshManagedInstanceId(host: string, stateRoot?: string): string {
  const digest = NodeCrypto.createHash("sha256")
    .update("ssh_managed", "utf8")
    .update("\0", "utf8")
    .update(host, "utf8")
    .update("\0", "utf8")
    .update(stateRoot ?? "", "utf8")
    .digest("base64url");
  return `ssh:${digest.slice(0, 22)}`;
}

/**
 * SSH-managed instances are configured, discovered, and rendered — but they are
 * not launchable in this slice. Activation would have to reach the remote
 * daemon's signaling endpoint, which is bound to the remote loopback interface;
 * see `CTOX_SSH_MANAGED_LAUNCH_BLOCKED_REASON`.
 */
export function isCtoxSshManagedInstance(instance: CtoxManagedInstance): boolean {
  return (
    instance.source === "ssh_managed" &&
    CTOX_SSH_MANAGED_ID_PATTERN.test(instance.id) &&
    instance.domain === undefined &&
    instance.healthSummary.dataPlane === "rxdb-webrtc" &&
    instance.healthSummary.httpDataProxy === false
  );
}

/**
 * Why no SSH-managed instance is launchable yet. A CTOX daemon's invite names
 * signaling endpoints on *its own* loopback interface (`ws://127.0.0.1:PORT`),
 * which the desktop cannot reach without a local port forward. The SSH package
 * does own such a forward — `startSshTunnel` in `packages/ssh/src/tunnel.ts`
 * spawns `ssh -N -L <local>:127.0.0.1:<remote>` — but it is module-private and
 * bound to the T3 server lifecycle: it takes a T3 HTTP base URL, gates
 * readiness on `waitForHttpReady`, and is reachable only through
 * `SshEnvironmentManager.ensureEnvironment`, which first installs and launches
 * the remote T3 CLI. Nothing generic is exported. Faking launchability would
 * mean handing the guest signaling URLs that resolve to the *desktop's* own
 * loopback, so activation stays closed until a reusable forward primitive
 * exists.
 */
export const CTOX_SSH_MANAGED_LAUNCH_BLOCKED_REASON = "ssh_tunnel_unavailable" as const;

/** POSIX single-quoting: the value can never escape its own argument. */
function singleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The remote command that reads one descriptor. It is a fixed script except for
 * the quoted state root, and `head -c` bounds the response at the source so a
 * hostile or broken remote cannot stream unbounded output at the desktop.
 */
export function buildCtoxSshDescriptorCommand(stateRoot?: string): readonly string[] {
  const assignment =
    stateRoot === undefined
      ? 'CTOX_ROOT="${CTOX_STATE_ROOT:-$HOME/.local/state/ctox}"'
      : `CTOX_ROOT=${singleQuote(stateRoot)}`;
  return [
    "sh",
    "-c",
    `${assignment}; head -c ${MAX_CTOX_DAEMON_DESCRIPTOR_BYTES} -- "$CTOX_ROOT/instance.json"`,
  ];
}

export interface CtoxSshExecInput {
  readonly host: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

export interface CtoxSshExecResult {
  readonly stdout: string;
}

/**
 * A bounded reason and nothing else. The underlying SSH error may quote a
 * destination, a path, or remote stderr, so it is never carried further: the
 * registry only needs to know that this host did not answer.
 */
export class CtoxSshExecError extends Schema.TaggedErrorClass<CtoxSshExecError>()(
  "CtoxSshExecError",
  { reason: Schema.Literals(["unreachable", "spawner_unavailable"]) },
) {
  override get message(): string {
    return "The SSH-managed CTOX host could not be reached.";
  }
}

/**
 * The injected SSH execution path. Production supplies `makeCtoxSshExec`, which
 * is `runSshCommand`; tests supply a fake. Any failure means "not discovered".
 */
export type CtoxSshExec = (
  input: CtoxSshExecInput,
) => Effect.Effect<CtoxSshExecResult, CtoxSshExecError>;

export interface CtoxSshManagedDiscoveryOptions {
  readonly exec?: CtoxSshExec;
  readonly nowEpochMs?: () => number;
}

export interface CtoxSshManagedInstance {
  readonly instance: CtoxManagedInstance;
  /** The configured destination. It stays in the main process. */
  readonly host: string;
  readonly runtimeStatus: CtoxLocalDaemonRuntimeStatus;
}

/**
 * The production SSH exec. It reuses `runSshCommand` unchanged, so the target
 * resolution, argument vector construction, authentication helpers, redaction,
 * and host-key behaviour are exactly the desktop's existing SSH semantics.
 * `BatchMode=yes` is the default whenever no interactive auth is requested, and
 * discovery never requests it: a host needing a password reads as offline
 * rather than interrupting the user with a prompt.
 */
export function makeCtoxSshExec(services: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): CtoxSshExec {
  return (input) => {
    const target: DesktopSshEnvironmentTarget = {
      alias: input.host,
      hostname: input.host,
      username: null,
      port: null,
    };
    return runSshCommand(target, {
      remoteCommandArgs: [...input.argv],
      timeoutMs: input.timeoutMs,
      batchMode: "yes",
    }).pipe(
      Effect.map((result): CtoxSshExecResult => ({ stdout: result.stdout })),
      Effect.mapError(() => new CtoxSshExecError({ reason: "unreachable" })),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, services.spawner),
      Effect.provideService(FileSystem.FileSystem, services.fileSystem),
      Effect.provideService(Path.Path, services.path),
    );
  };
}

function instanceStatus(
  runtimeStatus: CtoxLocalDaemonRuntimeStatus,
): CtoxManagedInstance["status"] {
  return runtimeStatus === "running" ? "available" : "offline";
}

/**
 * Reads one configured host's descriptor. Every failure mode — unreachable
 * host, refused key, missing file, oversized or malformed JSON — collapses to
 * an offline row.
 */
const discoverOne = Effect.fn("CtoxSshManagedSource.discoverOne")(function* (
  entry: CtoxSshManagedConfigEntry,
  exec: CtoxSshExec | undefined,
  nowEpochMs: number,
) {
  const stdout =
    exec === undefined
      ? undefined
      : yield* exec({
          host: entry.host,
          argv: buildCtoxSshDescriptorCommand(entry.stateRoot),
          timeoutMs: SSH_DESCRIPTOR_TIMEOUT_MS,
        }).pipe(
          Effect.map((result): string | undefined => result.stdout),
          Effect.orElseSucceed(() => undefined),
        );
  const descriptor = stdout === undefined ? undefined : yield* decodeCtoxDaemonDescriptor(stdout);
  const runtimeStatus: CtoxLocalDaemonRuntimeStatus =
    descriptor === undefined ? "stopped" : ctoxDaemonDeclaredStatus(descriptor, nowEpochMs);
  return {
    instance: {
      id: entry.id,
      source: "ssh_managed",
      displayName: entry.displayName,
      status: instanceStatus(runtimeStatus),
      healthSummary: {
        dataPlane: "rxdb-webrtc",
        dataPlaneReady: false,
        httpDataProxy: false,
        nativePeerObserved: false,
      },
    },
    host: entry.host,
    runtimeStatus,
  } satisfies CtoxSshManagedInstance;
});

/**
 * Discovers every configured SSH-managed instance. The result is renderer-safe
 * by construction: an opaque id, a bounded display name, a status, and the
 * fixed health summary — never a destination, path, port, or credential.
 */
export const discoverCtoxSshManagedInstances = Effect.fn(
  "CtoxSshManagedSource.discoverCtoxSshManagedInstances",
)(function* (
  entries: readonly CtoxSshManagedConfigEntry[],
  options: CtoxSshManagedDiscoveryOptions = {},
) {
  const bounded = entries.slice(0, MAX_SSH_INSTANCES);
  if (bounded.length === 0) return [] as readonly CtoxSshManagedInstance[];
  const nowEpochMs =
    options.nowEpochMs === undefined
      ? yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
      : options.nowEpochMs();
  const discovered = yield* Effect.forEach(
    bounded,
    (entry) => discoverOne(entry, options.exec, nowEpochMs),
    { concurrency: SSH_DISCOVERY_CONCURRENCY },
  );
  return discovered as readonly CtoxSshManagedInstance[];
});

export type CtoxSshManagedConfigMutation =
  | { readonly _tag: "updated"; readonly document: CtoxSshManagedConfigDocument }
  | { readonly _tag: "invalid" }
  | { readonly _tag: "not_found" }
  | { readonly _tag: "capacity" };

function sortEntries(
  entries: readonly CtoxSshManagedConfigEntry[],
): readonly CtoxSshManagedConfigEntry[] {
  return [...entries].sort((left, right) => {
    const leftName = left.displayName.toLowerCase();
    const rightName = right.displayName.toLowerCase();
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * Adds or replaces one configured instance. Re-adding the same host and state
 * root updates the display name in place instead of duplicating the row,
 * because the id is derived from the destination.
 */
export function addCtoxSshManagedEntry(
  document: CtoxSshManagedConfigDocument,
  input: CtoxSshManagedInstanceAddInput,
): CtoxSshManagedConfigMutation {
  const entry: CtoxSshManagedConfigEntry = {
    id: ctoxSshManagedInstanceId(input.host, input.stateRoot),
    host: input.host,
    displayName: input.displayName ?? input.host,
    ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }),
  };
  if (!Schema.is(CtoxSshManagedConfigEntry)(entry)) return { _tag: "invalid" };
  const retained = document.instances.filter((existing) => existing.id !== entry.id);
  if (retained.length >= MAX_SSH_INSTANCES) return { _tag: "capacity" };
  return {
    _tag: "updated",
    document: { version: CONFIG_VERSION, instances: sortEntries([...retained, entry]) },
  };
}

export function removeCtoxSshManagedEntry(
  document: CtoxSshManagedConfigDocument,
  instanceId: string,
): CtoxSshManagedConfigMutation {
  if (!CTOX_SSH_MANAGED_ID_PATTERN.test(instanceId)) return { _tag: "invalid" };
  if (!document.instances.some((entry) => entry.id === instanceId)) return { _tag: "not_found" };
  return {
    _tag: "updated",
    document: {
      version: CONFIG_VERSION,
      instances: document.instances.filter((entry) => entry.id !== instanceId),
    },
  };
}

/**
 * A persisted entry is trusted only when its id is exactly the digest of its
 * own destination, so an edited configuration file cannot smuggle a row in
 * under a foreign id.
 */
export function isConsistentCtoxSshManagedEntry(entry: CtoxSshManagedConfigEntry): boolean {
  return entry.id === ctoxSshManagedInstanceId(entry.host, entry.stateRoot);
}

/** Renderer-safe descriptor of one configured entry, before any probing. */
export function ctoxSshManagedDescriptor(entry: CtoxSshManagedConfigEntry): CtoxManagedInstance {
  return {
    id: entry.id,
    source: "ssh_managed",
    displayName: entry.displayName,
    status: "offline",
    healthSummary: {
      dataPlane: "rxdb-webrtc",
      dataPlaneReady: false,
      httpDataProxy: false,
      nativePeerObserved: false,
    },
  };
}
