// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeCrypto from "node:crypto";

import type { CtoxManagedInstance } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Read-only discovery of CTOX daemons installed on this machine.
 *
 * Discovery never spawns, installs, or mutates anything: it reads a bounded
 * versioned descriptor below a well-known state root and — only when the
 * descriptor itself declares one — probes a loopback health endpoint. Any
 * missing, oversized, or non-conforming input is simply "not discovered"; the
 * effect cannot fail, so a broken local installation can never break the one
 * shared instance registry.
 */

const DESCRIPTOR_VERSION = 1;
const DESCRIPTOR_FILE = "instance.json";
const INSTANCES_DIRECTORY = "instances";
const DEFAULT_STATE_ROOT_SEGMENTS = [".local", "state", "ctox"] as const;
const STATE_ROOT_ENV_KEY = "CTOX_STATE_ROOT";
/** Bounded fan-out: a workstation runs a handful of daemons, never a fleet. */
const MAX_SCANNED_DIRECTORY_ENTRIES = 16;
const MAX_LOCAL_INSTANCES = 4;
const MAX_DESCRIPTOR_BYTES = 65_536;
/** A self-declared "running" older than this is downgraded to "unknown". */
const RUNNING_STALENESS_MS = 120_000;
const HEALTH_PROBE_TIMEOUT_MS = 1_000;
const textEncoder = new TextEncoder();

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
const DescriptorInstanceId = SafeText.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
);
const DescriptorDisplayName = SafeText.check(Schema.isMaxLength(256));
const DescriptorHealthUrl = SafeText.check(Schema.isMaxLength(2_048));
const DescriptorEpochMs = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * The minimal versioned local-daemon descriptor. It is decoded with
 * `onExcessProperty: "error"`, so a descriptor that carries pairing material,
 * tokens, or any other unexpected key is rejected instead of being surfaced.
 */
export const CtoxDaemonDescriptor = Schema.Struct({
  version: Schema.Literal(DESCRIPTOR_VERSION),
  instanceId: DescriptorInstanceId,
  displayName: Schema.optionalKey(DescriptorDisplayName),
  status: Schema.optionalKey(Schema.Literals(["running", "stopped"])),
  lastSeenAt: Schema.optionalKey(DescriptorEpochMs),
  healthUrl: Schema.optionalKey(DescriptorHealthUrl),
});
export type CtoxDaemonDescriptor = typeof CtoxDaemonDescriptor.Type;
type LocalDaemonDescriptor = CtoxDaemonDescriptor;

const LocalDaemonDescriptorJson = Schema.fromJsonString(CtoxDaemonDescriptor);
const decodeDescriptor = Schema.decodeUnknownEffect(LocalDaemonDescriptorJson);

/** The descriptor file name every CTOX daemon writes below its state root. */
export const CTOX_DAEMON_DESCRIPTOR_FILE = DESCRIPTOR_FILE;
/** The size beyond which a descriptor is refused rather than parsed. */
export const MAX_CTOX_DAEMON_DESCRIPTOR_BYTES = MAX_DESCRIPTOR_BYTES;

/**
 * The one CTOX daemon descriptor decoder, shared by every source that reads
 * `instance.json` — locally through the file system, or over SSH. Oversized,
 * malformed, or excess-key input decodes to `undefined` rather than failing,
 * so a broken daemon is simply "not discovered".
 */
export function decodeCtoxDaemonDescriptor(
  raw: string,
): Effect.Effect<CtoxDaemonDescriptor | undefined> {
  return Effect.succeed(raw).pipe(
    Effect.filterOrFail(
      (value) => textEncoder.encode(value).length <= MAX_DESCRIPTOR_BYTES,
      () => "oversized_descriptor" as const,
    ),
    Effect.flatMap((value) => decodeDescriptor(value, { onExcessProperty: "error" })),
    Effect.map((descriptor): CtoxDaemonDescriptor | undefined => descriptor),
    Effect.orElseSucceed(() => undefined),
  );
}

export type CtoxLocalDaemonRuntimeStatus = "running" | "stopped" | "unknown";

/** A discovered local daemon plus the runtime facts the registry does not carry. */
export interface CtoxLocalDaemonInstance {
  readonly instance: CtoxManagedInstance;
  /**
   * The daemon's own declared instance id. It stays in the main process: the
   * launch path uses it to check that the invite it just minted really came
   * from the daemon the user picked, and `instance.id` deliberately hides it.
   */
  readonly daemonInstanceId: string;
  readonly runtimeStatus: CtoxLocalDaemonRuntimeStatus;
  readonly lastSeenAt?: number;
}

export interface CtoxLocalDaemonProbeResponse {
  readonly ok: boolean;
}

export type CtoxLocalDaemonProbe = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<CtoxLocalDaemonProbeResponse>;

export interface CtoxLocalDaemonDiscoveryOptions {
  readonly homeDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nowEpochMs?: () => number;
  /**
   * Omitted disables health probing; discovery then relies on the descriptor.
   * A concrete probe is injected the same way CtoxDevAuth injects its Electron
   * session fetch, so this module never reaches for a global HTTP client.
   */
  readonly probe?: CtoxLocalDaemonProbe;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]") {
    return true;
  }
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

/** Only a credential-free loopback health URL is ever contacted. */
export function normalizeCtoxLocalDaemonHealthUrl(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== "" ||
    !isLoopbackHostname(url.hostname.toLowerCase())
  ) {
    return undefined;
  }
  return url.toString();
}

/**
 * Stable renderer id of a local daemon. It is derived from the descriptor path
 * below the state root, so it survives restarts and never leaks that path.
 */
export function ctoxLocalDaemonInstanceId(descriptorPath: string): string {
  const digest = NodeCrypto.createHash("sha256")
    .update("local_daemon", "utf8")
    .update("\0", "utf8")
    .update(descriptorPath, "utf8")
    .digest("base64url");
  return `local:${digest.slice(0, 22)}`;
}

/** Shape of every id this module mints; nothing else may be treated as local. */
export const CTOX_LOCAL_DAEMON_ID_PATTERN = /^local:[A-Za-z0-9_-]{22}$/;

/**
 * The single launchability predicate for local daemons. Discovery, the session
 * partition guard, and the guest manager all ask it, so a descriptor that was
 * never produced by `discoverCtoxLocalDaemonInstances` cannot reach a launch.
 */
export function isLaunchableCtoxLocalDaemon(instance: CtoxManagedInstance): boolean {
  return (
    instance.source === "local_daemon" &&
    instance.status === "available" &&
    CTOX_LOCAL_DAEMON_ID_PATTERN.test(instance.id) &&
    instance.domain === undefined &&
    instance.healthSummary.dataPlane === "rxdb-webrtc" &&
    instance.healthSummary.dataPlaneReady === false &&
    instance.healthSummary.httpDataProxy === false &&
    instance.healthSummary.nativePeerObserved === false
  );
}

export function resolveCtoxLocalDaemonStateRoot(
  options: CtoxLocalDaemonDiscoveryOptions,
  path: Path.Path,
): string | undefined {
  const override = options.env?.[STATE_ROOT_ENV_KEY]?.trim();
  if (override !== undefined && override.length > 0) {
    return path.isAbsolute(override) ? override : undefined;
  }
  const home = options.homeDirectory?.trim();
  if (home === undefined || home.length === 0 || !path.isAbsolute(home)) return undefined;
  return path.join(home, ...DEFAULT_STATE_ROOT_SEGMENTS);
}

function descriptorDisplayName(
  descriptor: LocalDaemonDescriptor,
  descriptorPath: string,
  path: Path.Path,
): string {
  if (descriptor.displayName !== undefined) return descriptor.displayName;
  const directory = path.basename(path.dirname(descriptorPath));
  if (directory.length > 0 && directory.length <= 256) return `${directory} (local)`;
  return descriptor.instanceId;
}

function readDescriptor(
  fileSystem: FileSystem.FileSystem,
  descriptorPath: string,
): Effect.Effect<LocalDaemonDescriptor | undefined> {
  return fileSystem.readFileString(descriptorPath).pipe(
    Effect.flatMap(decodeCtoxDaemonDescriptor),
    Effect.orElseSucceed((): LocalDaemonDescriptor | undefined => undefined),
  );
}

function descriptorPaths(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  stateRoot: string,
): Effect.Effect<readonly string[]> {
  return fileSystem.readDirectory(path.join(stateRoot, INSTANCES_DIRECTORY)).pipe(
    Effect.orElseSucceed((): readonly string[] => []),
    Effect.map((entries) => {
      const scanned = [...entries]
        .filter((entry) => entry.length > 0 && entry !== "." && entry !== "..")
        .sort()
        .slice(0, MAX_SCANNED_DIRECTORY_ENTRIES)
        .map((entry) => path.join(stateRoot, INSTANCES_DIRECTORY, entry, DESCRIPTOR_FILE));
      return [path.join(stateRoot, DESCRIPTOR_FILE), ...scanned];
    }),
  );
}

function probeHealth(
  probe: CtoxLocalDaemonProbe,
  healthUrl: string,
): Effect.Effect<CtoxLocalDaemonRuntimeStatus> {
  return Effect.tryPromise({
    try: () => probe(healthUrl, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) }),
    catch: () => undefined,
  }).pipe(
    Effect.map(
      (response): CtoxLocalDaemonRuntimeStatus =>
        typeof response === "object" && response !== null && response.ok === true
          ? "running"
          : "stopped",
    ),
    Effect.orElseSucceed((): CtoxLocalDaemonRuntimeStatus => "stopped"),
  );
}

/**
 * Runtime status a descriptor declares about itself. A "running" claim older
 * than the staleness window degrades to "unknown" rather than being believed.
 */
export function ctoxDaemonDeclaredStatus(
  descriptor: CtoxDaemonDescriptor,
  nowEpochMs: number,
): CtoxLocalDaemonRuntimeStatus {
  if (descriptor.status === undefined) return "unknown";
  if (descriptor.status === "stopped") return "stopped";
  if (descriptor.lastSeenAt === undefined) return "unknown";
  return nowEpochMs - descriptor.lastSeenAt > RUNNING_STALENESS_MS ? "unknown" : "running";
}

/**
 * Only a daemon that is observably running is offered as launchable: the
 * launch path mints its pairing material from that daemon's own CLI, so a
 * stale or stopped descriptor must read as offline rather than as available.
 */
function instanceStatus(
  runtimeStatus: CtoxLocalDaemonRuntimeStatus,
): CtoxManagedInstance["status"] {
  return runtimeStatus === "running" ? "available" : "offline";
}

/**
 * Discovers local CTOX daemons. The result is renderer-safe by construction:
 * it contains only an opaque id, a bounded display name, a status, and the
 * fixed health summary — never a path, URL, port, token, or pairing material.
 */
export const discoverCtoxLocalDaemonInstances = Effect.fn(
  "CtoxLocalDaemonSource.discoverCtoxLocalDaemonInstances",
)(function* (options: CtoxLocalDaemonDiscoveryOptions = {}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateRoot = resolveCtoxLocalDaemonStateRoot(options, path);
  if (stateRoot === undefined) return [] as readonly CtoxLocalDaemonInstance[];

  const nowEpochMs =
    options.nowEpochMs === undefined
      ? yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
      : options.nowEpochMs();
  const candidates = yield* descriptorPaths(fileSystem, path, stateRoot);
  const discovered: CtoxLocalDaemonInstance[] = [];
  const seenInstanceIds = new Set<string>();

  for (const descriptorPath of candidates) {
    if (discovered.length >= MAX_LOCAL_INSTANCES) break;
    const descriptor = yield* readDescriptor(fileSystem, descriptorPath);
    if (descriptor === undefined || seenInstanceIds.has(descriptor.instanceId)) continue;
    seenInstanceIds.add(descriptor.instanceId);

    const healthUrl =
      descriptor.healthUrl === undefined
        ? undefined
        : normalizeCtoxLocalDaemonHealthUrl(descriptor.healthUrl);
    const runtimeStatus =
      healthUrl === undefined || options.probe === undefined
        ? ctoxDaemonDeclaredStatus(descriptor, nowEpochMs)
        : yield* probeHealth(options.probe, healthUrl);

    discovered.push({
      instance: {
        id: ctoxLocalDaemonInstanceId(descriptorPath),
        source: "local_daemon",
        displayName: descriptorDisplayName(descriptor, descriptorPath, path),
        status: instanceStatus(runtimeStatus),
        healthSummary: {
          dataPlane: "rxdb-webrtc",
          dataPlaneReady: false,
          httpDataProxy: false,
          nativePeerObserved: false,
        },
      },
      daemonInstanceId: descriptor.instanceId,
      runtimeStatus,
      ...(descriptor.lastSeenAt === undefined ? {} : { lastSeenAt: descriptor.lastSeenAt }),
    });
  }

  return discovered as readonly CtoxLocalDaemonInstance[];
});
