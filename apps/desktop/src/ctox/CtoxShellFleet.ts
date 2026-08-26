// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off - fleet state and child processes belong to Electron main.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  BusinessOsShellUpdateStatus,
  type CtoxManagedInstance,
  type CtoxShellFleetActionInput,
  type CtoxShellFleetActionResult,
  type CtoxShellFleetBlocker,
  type CtoxShellFleetInventoryResult,
  type CtoxShellFleetPauseInput,
  type CtoxShellFleetRow,
  type CtoxShellFleetRolloutResult,
  type CtoxShellFleetRolloutStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { CTOX_SHELL_FLEET_ROLLOUT_STATUS_EVENT } from "../ipc/channels.ts";
import * as CtoxDevAuth from "./CtoxDevAuth.ts";
import * as CtoxInstanceRegistry from "./CtoxInstanceRegistry.ts";
import { resolveCtoxBinary } from "./CtoxLocalDaemonLaunch.ts";
import {
  buildCtoxSshDataPlaneStatusCommand,
  buildCtoxSshShellUpdateCommand,
  buildCtoxSshServiceRestartCommand,
  buildCtoxSshVersionCommand,
  type CtoxShellUpdateCliAction,
  CTOX_SSH_SHELL_UPDATE_FAILURE_MARKER,
  CTOX_SSH_DATA_PLANE_STATUS_FAILURE_MARKER,
  CTOX_SSH_SERVICE_RESTART_FAILURE_MARKER,
  CTOX_SSH_VERSION_FAILURE_MARKER,
  makeCtoxSshExec,
} from "./CtoxSshManagedSource.ts";

const MAX_OUTPUT_BYTES = 65_536;
const COMMAND_TIMEOUT = Duration.minutes(15);
const PAUSE_FILE = "ctox-shell-fleet-pauses.json";
export const CTOX_SHELL_FLEET_STATUS_FILE = "ctox/shell-fleet-status.json";
export const CTOX_SHELL_FLEET_ROLLOUT_POLICY = Object.freeze({
  startupDelay: "30 seconds",
  checkInterval: "6 hours",
  localCanaryObservation: "10 minutes",
  waveObservation: "15 minutes",
  automaticRetryCount: 1,
});

interface PauseRecord {
  readonly reason: string;
  readonly expiresAt: string;
}

type PauseMap = Readonly<Record<string, PauseRecord>>;

export class CtoxShellFleet extends Context.Service<
  CtoxShellFleet,
  {
    readonly inventory: Effect.Effect<CtoxShellFleetInventoryResult>;
    readonly action: (
      input: CtoxShellFleetActionInput,
    ) => Effect.Effect<CtoxShellFleetActionResult>;
    readonly pause: (
      input: CtoxShellFleetPauseInput,
    ) => Effect.Effect<CtoxShellFleetInventoryResult>;
    readonly resume: (instanceId: string) => Effect.Effect<CtoxShellFleetInventoryResult>;
    readonly rolloutStatus: Effect.Effect<CtoxShellFleetRolloutStatus>;
    readonly startRollout: Effect.Effect<CtoxShellFleetRolloutResult>;
    readonly subscribeRollout: (
      listener: (status: CtoxShellFleetRolloutStatus) => void,
    ) => Effect.Effect<() => void>;
  }
>()("@t3tools/desktop/ctox/CtoxShellFleet") {}

function blockedStatus(administrable: boolean): BusinessOsShellUpdateStatus {
  return {
    activeVersion: null,
    desiredVersion: null,
    latestCompatibleVersion: null,
    channel: "stable",
    phase: "blocked",
    health: "unknown",
    administrable,
    recoveryShell: true,
    lastCheckedAt: null,
    lastActivatedAt: null,
    errorCode: null,
    pause: null,
  };
}

function blockedRow(
  instance: CtoxManagedInstance,
  blocker: CtoxShellFleetBlocker,
  requiredOperatorStep: string,
): CtoxShellFleetRow {
  return {
    instanceId: instance.id,
    displayName: instance.displayName,
    source: instance.source,
    reachable: instance.status !== "offline",
    backendVersion: null,
    shell: blockedStatus(false),
    blocker,
    requiredOperatorStep,
  };
}

function parseStatus(raw: string): BusinessOsShellUpdateStatus {
  if (Buffer.byteLength(raw, "utf8") > MAX_OUTPUT_BYTES) throw new Error("oversized");
  return Schema.decodeUnknownSync(BusinessOsShellUpdateStatus)(JSON.parse(raw), {
    onExcessProperty: "error",
  });
}

export function parseCtoxBackendVersion(raw: string): string {
  if (Buffer.byteLength(raw, "utf8") > MAX_OUTPUT_BYTES) throw new Error("oversized");
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_response");
  }
  const version = (value as Record<string, unknown>).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("invalid_version");
  }
  return version;
}

export interface CtoxDataPlaneProbe {
  readonly nativePeerObserved: boolean;
  readonly dataPlaneReady: boolean;
}

export function ctoxShellFleetRowFromStatus(input: {
  readonly instance: CtoxManagedInstance;
  readonly shell: BusinessOsShellUpdateStatus;
  readonly dataPlane: CtoxDataPlaneProbe;
}): CtoxShellFleetRow {
  const blocker: CtoxShellFleetBlocker | null = !input.shell.administrable
    ? "no_administrative_access"
    : input.dataPlane.dataPlaneReady
      ? null
      : "data_plane_degraded";
  const requiredOperatorStep =
    blocker === "no_administrative_access"
      ? "Administratorzugriff herstellen."
      : blocker === "data_plane_degraded"
        ? input.dataPlane.nativePeerObserved
          ? "Workjet mit der Instanz verbinden und den authentifizierten RxDB/WebRTC-Datenkanal prüfen."
          : "CTOX Sync Engine starten, Heartbeat und Health reparieren."
        : null;
  return {
    instanceId: input.instance.id,
    displayName: input.instance.displayName,
    source: input.instance.source,
    reachable: true,
    backendVersion: null,
    shell: {
      ...input.shell,
      health: input.dataPlane.dataPlaneReady ? "healthy" : "degraded",
    },
    blocker,
    requiredOperatorStep,
  };
}

function readBoolean(object: unknown, key: string): boolean {
  return (
    typeof object === "object" &&
    object !== null &&
    !Array.isArray(object) &&
    (object as Record<string, unknown>)[key] === true
  );
}

/**
 * Reduces the secret-free native peer health document to the two facts the
 * fleet controller needs. A coarse `replicationUp` bit alone is deliberately
 * insufficient: a rollout is healthy only after the authenticated browser
 * peer and its command consumer are actually connected.
 */
export function parseCtoxDataPlaneProbe(raw: string): CtoxDataPlaneProbe {
  if (Buffer.byteLength(raw, "utf8") > MAX_OUTPUT_BYTES) throw new Error("oversized");
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_response");
  }
  const record = value as Record<string, unknown>;
  const heartbeat = record.heartbeat;
  const health = record.health;
  const stages = record.health_stages;
  const nativePeerObserved =
    readBoolean(record, "running") &&
    readBoolean(heartbeat, "fresh") &&
    typeof health === "object" &&
    health !== null &&
    !Array.isArray(health) &&
    (health as Record<string, unknown>).errorTotal === 0 &&
    readBoolean(stages, "process_alive");
  return {
    nativePeerObserved,
    dataPlaneReady:
      nativePeerObserved &&
      readBoolean(record, "replicationUp") &&
      readBoolean(stages, "signaling_socket_connected") &&
      readBoolean(stages, "signaling_join_accepted") &&
      readBoolean(stages, "peer_authenticated") &&
      readBoolean(stages, "data_channel_open") &&
      readBoolean(stages, "command_consumer_alive"),
  };
}

function collectBounded<E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> {
  return stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulated, chunk) =>
        Buffer.byteLength(accumulated, "utf8") > MAX_OUTPUT_BYTES
          ? accumulated
          : accumulated + chunk,
    ),
  );
}

export function planCtoxShellRolloutWaves(rows: readonly CtoxShellFleetRow[]): readonly string[][] {
  const eligible = rows.filter(
    (row) =>
      row.blocker === null &&
      row.reachable &&
      row.shell.administrable &&
      row.shell.phase !== "current",
  );
  const waves: string[][] = [];
  const remaining = [...eligible];
  const localIndex = remaining.findIndex((row) => row.source === "local_daemon");
  if (localIndex >= 0) waves.push([remaining.splice(localIndex, 1)[0]!.instanceId]);
  const gpu3Index = remaining.findIndex((row) => /gpu\s*3/i.test(row.displayName));
  if (gpu3Index >= 0) waves.push([remaining.splice(gpu3Index, 1)[0]!.instanceId]);
  const waveSize = Math.max(1, Math.min(3, Math.floor(Math.max(rows.length, 1) * 0.25)));
  while (remaining.length > 0)
    waves.push(remaining.splice(0, waveSize).map((row) => row.instanceId));
  return waves;
}

export const make = Effect.fn("CtoxShellFleet.make")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const auth = yield* CtoxDevAuth.CtoxDevAuth;
  const registry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parentScope = yield* Scope.Scope;
  const pausePath = NodePath.join(environment.stateDir, PAUSE_FILE);
  const statusPath = NodePath.join(environment.stateDir, CTOX_SHELL_FLEET_STATUS_FILE);
  const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());
  const initialRolloutStatus: CtoxShellFleetRolloutStatus = {
    phase: "idle",
    releaseVersion: null,
    startedAt: null,
    updatedAt: nowIso(),
    currentWave: 0,
    totalWaves: 0,
    instanceIds: [],
    completedInstanceIds: [],
    failedInstanceId: null,
    errorCode: null,
  };
  const rolloutRef = yield* SynchronizedRef.make(initialRolloutStatus);
  const rolloutListeners = new Set<(status: CtoxShellFleetRolloutStatus) => void>();
  const publishRollout = (status: CtoxShellFleetRolloutStatus) =>
    SynchronizedRef.set(rolloutRef, status).pipe(
      Effect.andThen(
        Effect.sync(() => {
          for (const listener of rolloutListeners) listener(status);
        }),
      ),
      Effect.andThen(electronWindow.sendAll(CTOX_SHELL_FLEET_ROLLOUT_STATUS_EVENT, status)),
    );

  const readPauses = async (): Promise<PauseMap> => {
    try {
      const value = JSON.parse(await NodeFSP.readFile(pausePath, "utf8")) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
      const pauses: Record<string, PauseRecord> = {};
      for (const [id, record] of Object.entries(value)) {
        if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
        const reason = (record as Record<string, unknown>).reason;
        const expiresAt = (record as Record<string, unknown>).expiresAt;
        if (
          typeof reason === "string" &&
          reason.length > 0 &&
          reason.length <= 256 &&
          typeof expiresAt === "string" &&
          Number.isFinite(Date.parse(expiresAt))
        ) {
          pauses[id] = { reason, expiresAt };
        }
      }
      return pauses;
    } catch {
      return {};
    }
  };

  const writePauses = async (pauses: PauseMap): Promise<void> => {
    await NodeFSP.mkdir(NodePath.dirname(pausePath), { recursive: true });
    const temporary = `${pausePath}.${process.pid}.tmp`;
    await NodeFSP.writeFile(temporary, `${JSON.stringify(pauses, null, 2)}\n`, { mode: 0o600 });
    await NodeFSP.rename(temporary, pausePath);
  };

  const writeStatuses = async (rows: readonly CtoxShellFleetRow[]): Promise<void> => {
    await NodeFSP.mkdir(NodePath.dirname(statusPath), { recursive: true });
    const temporary = `${statusPath}.${process.pid}.tmp`;
    await NodeFSP.writeFile(
      temporary,
      `${JSON.stringify({ version: 1, rows: rows.map(({ instanceId, shell }) => ({ instanceId, shell })) }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await NodeFSP.rename(temporary, statusPath);
  };

  const localExec = (args: readonly string[]): Effect.Effect<string, "command_failed"> =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(resolveCtoxBinary(process.env), args, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [collectBounded(child.stdout), collectBounded(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      if (Number(exitCode) !== 0 || Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
        return yield* Effect.fail("command_failed" as const);
      }
      return stdout;
    }).pipe(
      Effect.scoped,
      Effect.timeout(COMMAND_TIMEOUT),
      Effect.mapError(() => "command_failed" as const),
    );

  const localCommand = (action: CtoxShellUpdateCliAction) =>
    localExec(["business-os", "shell-update", action]);

  const readBackendVersion = Effect.fn("CtoxShellFleet.readBackendVersion")(function* (
    instance: CtoxManagedInstance,
  ) {
    let stdout: string;
    if (instance.source === "local_daemon") {
      stdout = yield* localExec(["version"]);
    } else if (instance.source === "ssh_managed") {
      const target = yield* registry.resolveSshManagedTarget(instance.id);
      const result = yield* sshExec({
        host: target.host,
        argv: buildCtoxSshVersionCommand(target.stateRoot),
        timeoutMs: Duration.toMillis(COMMAND_TIMEOUT),
      });
      if (result.stderr?.includes(CTOX_SSH_VERSION_FAILURE_MARKER)) {
        return yield* Effect.fail("command_failed" as const);
      }
      stdout = result.stdout;
    } else {
      return yield* Effect.fail("not_administrable" as const);
    }
    return yield* Effect.try({
      try: () => parseCtoxBackendVersion(stdout),
      catch: () => "invalid_response" as const,
    });
  });

  const probeDataPlane = Effect.fn("CtoxShellFleet.probeDataPlane")(function* (
    instance: CtoxManagedInstance,
  ) {
    let stdout: string;
    if (instance.source === "local_daemon") {
      stdout = yield* localExec(["business-os", "rxdb", "status", "--json"]);
    } else if (instance.source === "ssh_managed") {
      const target = yield* registry.resolveSshManagedTarget(instance.id);
      const result = yield* sshExec({
        host: target.host,
        argv: buildCtoxSshDataPlaneStatusCommand(target.stateRoot),
        timeoutMs: Duration.toMillis(COMMAND_TIMEOUT),
      });
      if (result.stderr?.includes(CTOX_SSH_DATA_PLANE_STATUS_FAILURE_MARKER)) {
        return yield* Effect.fail("command_failed" as const);
      }
      stdout = result.stdout;
    } else {
      return yield* Effect.fail("not_administrable" as const);
    }
    return yield* Effect.try({
      try: () => parseCtoxDataPlaneProbe(stdout),
      catch: () => "invalid_response" as const,
    });
  });

  const sshExec = makeCtoxSshExec({
    spawner,
    fileSystem,
    path,
  });

  const run = Effect.fn("CtoxShellFleet.run")(function* (
    instance: CtoxManagedInstance,
    action: CtoxShellUpdateCliAction,
  ) {
    if (instance.source === "local_daemon") {
      const target = yield* registry.resolveLocalDaemonTarget(instance.id);
      if (target.discoveredCount !== 1) return yield* Effect.fail("not_administrable" as const);
      const stdout = yield* localCommand(action);
      return yield* Effect.try({
        try: () => parseStatus(stdout),
        catch: () => "invalid_response" as const,
      });
    }
    if (instance.source === "ssh_managed") {
      const target = yield* registry.resolveSshManagedTarget(instance.id);
      const command = buildCtoxSshShellUpdateCommand(action, target.stateRoot);
      const result = yield* sshExec({
        host: target.host,
        argv: command,
        timeoutMs: Duration.toMillis(COMMAND_TIMEOUT),
      });
      if (result.stderr?.includes(CTOX_SSH_SHELL_UPDATE_FAILURE_MARKER)) {
        return yield* Effect.fail("command_failed" as const);
      }
      return yield* Effect.try({
        try: () => parseStatus(result.stdout),
        catch: () => "invalid_response" as const,
      });
    }
    return yield* Effect.fail("not_administrable" as const);
  });

  const restartBackend = Effect.fn("CtoxShellFleet.restartBackend")(function* (
    instance: CtoxManagedInstance,
  ) {
    if (instance.source === "local_daemon") {
      yield* localExec(["stop"]);
      yield* localExec(["start"]);
      return;
    }
    if (instance.source === "ssh_managed") {
      const target = yield* registry.resolveSshManagedTarget(instance.id);
      const result = yield* sshExec({
        host: target.host,
        argv: buildCtoxSshServiceRestartCommand(target.stateRoot),
        timeoutMs: Duration.toMillis(COMMAND_TIMEOUT),
      });
      if (result.stderr?.includes(CTOX_SSH_SERVICE_RESTART_FAILURE_MARKER)) {
        return yield* Effect.fail("command_failed" as const);
      }
      return;
    }
    return yield* Effect.fail("not_administrable" as const);
  });

  const discover = Effect.gen(function* () {
    const managed = yield* auth.refresh.pipe(
      Effect.orElseSucceed(() => ({ _tag: "failed", code: "network_error" }) as const),
    );
    const discovery = yield* registry.merge(managed);
    return discovery._tag === "ready" ? discovery.instances : [];
  });

  const inventory = Effect.gen(function* () {
    const instances = yield* discover;
    const pauses = yield* Effect.promise(readPauses);
    const currentDateTime = yield* DateTime.now;
    const currentTime = DateTime.toEpochMillis(currentDateTime);
    const rows = yield* Effect.forEach(
      instances,
      (instance): Effect.Effect<CtoxShellFleetRow> => {
        const pause = pauses[instance.id];
        if (pause !== undefined && Date.parse(pause.expiresAt) > currentTime) {
          const row = blockedRow(
            instance,
            "paused",
            "Pause in Workjet fortsetzen oder ablaufen lassen.",
          );
          return Effect.succeed({
            ...row,
            shell: { ...row.shell, pause, phase: "blocked" },
          });
        }
        if (instance.status === "offline") {
          return Effect.succeed(
            blockedRow(instance, "offline", "Rechner starten oder Netzwerk prüfen."),
          );
        }
        if (instance.source !== "local_daemon" && instance.source !== "ssh_managed") {
          return Effect.succeed(
            blockedRow(
              instance,
              "no_administrative_access",
              "Instanz als lokalen oder SSH-verwalteten Rechner hinzufügen.",
            ),
          );
        }
        return Effect.all({
          shell: run(instance, "status"),
          dataPlane: probeDataPlane(instance),
          backendVersion: readBackendVersion(instance),
        }).pipe(
          Effect.map(({ shell, dataPlane, backendVersion }) => ({
            ...ctoxShellFleetRowFromStatus({ instance, shell, dataPlane }),
            backendVersion,
          })),
          Effect.orElseSucceed(() =>
            blockedRow(instance, "backend_unavailable", "CTOX aktualisieren und erneut prüfen."),
          ),
        );
      },
      { concurrency: 4 },
    );
    yield* Effect.promise(() => writeStatuses(rows));
    return {
      _tag: "completed",
      checkedAt: DateTime.formatIso(currentDateTime),
      rows,
    } as const;
  }).pipe(
    Effect.orElseSucceed(
      (): CtoxShellFleetInventoryResult => ({ _tag: "failed", code: "inventory_failed" }),
    ),
  );

  const action = (input: CtoxShellFleetActionInput): Effect.Effect<CtoxShellFleetActionResult> =>
    Effect.gen(function* () {
      const instances = yield* discover;
      const instance = instances.find((candidate) => candidate.id === input.instanceId);
      if (instance === undefined) return { _tag: "failed", code: "unknown_instance" } as const;
      if (instance.source !== "local_daemon" && instance.source !== "ssh_managed") {
        return { _tag: "failed", code: "not_administrable" } as const;
      }
      let shell: BusinessOsShellUpdateStatus;
      if (input.action === "check") {
        shell = yield* run(instance, "check");
      } else if (input.action === "rollback") {
        yield* run(instance, "rollback");
        yield* restartBackend(instance);
        yield* Effect.sleep("2 seconds");
        shell = yield* run(instance, "status");
      } else {
        yield* run(instance, "check");
        yield* run(instance, "stage");
        yield* run(instance, "activate");
        yield* restartBackend(instance);
        yield* Effect.sleep("2 seconds");
        shell = yield* run(instance, "status");
      }
      const [backendVersion, dataPlane] = yield* Effect.all([
        readBackendVersion(instance).pipe(Effect.orElseSucceed(() => null)),
        probeDataPlane(instance).pipe(
          Effect.orElseSucceed(() => ({ nativePeerObserved: false, dataPlaneReady: false })),
        ),
      ]);
      const row: CtoxShellFleetRow = {
        ...ctoxShellFleetRowFromStatus({ instance, shell, dataPlane }),
        backendVersion,
      };
      const current = yield* inventory;
      if (current._tag === "completed") {
        yield* Effect.promise(() =>
          writeStatuses(
            current.rows.map((candidate) =>
              candidate.instanceId === row.instanceId ? row : candidate,
            ),
          ),
        );
      }
      return {
        _tag: "completed",
        row,
      } as const;
    }).pipe(
      Effect.orElseSucceed(
        (): CtoxShellFleetActionResult => ({ _tag: "failed", code: "operation_failed" }),
      ),
    );

  const pause = (input: CtoxShellFleetPauseInput) =>
    Effect.promise(async () => {
      const pauses = await readPauses();
      await writePauses({
        ...pauses,
        [input.instanceId]: { reason: input.reason, expiresAt: input.expiresAt },
      });
    }).pipe(Effect.andThen(inventory));
  const resume = (instanceId: string) =>
    Effect.promise(async () => {
      const { [instanceId]: _removed, ...pauses } = await readPauses();
      await writePauses(pauses);
    }).pipe(Effect.andThen(inventory));

  const runningPhases = new Set<CtoxShellFleetRolloutStatus["phase"]>([
    "inventory",
    "local_canary",
    "platform_canary",
    "wave",
    "observing",
  ]);

  const executeRollout = Effect.fn("CtoxShellFleet.executeRollout")(function* (
    waves: readonly (readonly string[])[],
    started: CtoxShellFleetRolloutStatus,
  ) {
    const completed: string[] = [];
    for (const [waveIndex, wave] of waves.entries()) {
      const phase = waveIndex === 0 ? "local_canary" : waveIndex === 1 ? "platform_canary" : "wave";
      yield* publishRollout({
        ...started,
        phase,
        updatedAt: nowIso(),
        currentWave: waveIndex + 1,
        completedInstanceIds: [...completed],
      });
      for (const instanceId of wave) {
        let result = yield* action({ instanceId, action: "update" });
        for (
          let retry = 0;
          result._tag === "failed" && retry < CTOX_SHELL_FLEET_ROLLOUT_POLICY.automaticRetryCount;
          retry += 1
        ) {
          result = yield* action({ instanceId, action: "update" });
        }
        if (result._tag === "failed") {
          yield* action({ instanceId, action: "rollback" }).pipe(Effect.ignore);
          yield* publishRollout({
            ...started,
            phase: "failed",
            updatedAt: nowIso(),
            currentWave: waveIndex + 1,
            completedInstanceIds: [...completed],
            failedInstanceId: instanceId,
            errorCode: "update_failed_after_retry",
          });
          return;
        }
        completed.push(instanceId);
      }
      yield* publishRollout({
        ...started,
        phase: "observing",
        updatedAt: nowIso(),
        currentWave: waveIndex + 1,
        completedInstanceIds: [...completed],
      });
      yield* Effect.sleep(
        waveIndex === 0
          ? CTOX_SHELL_FLEET_ROLLOUT_POLICY.localCanaryObservation
          : CTOX_SHELL_FLEET_ROLLOUT_POLICY.waveObservation,
      );
      const observed = yield* inventory;
      const unhealthy =
        observed._tag === "completed"
          ? wave.find((instanceId) => {
              const row = observed.rows.find((candidate) => candidate.instanceId === instanceId);
              return (
                row === undefined ||
                row.blocker !== null ||
                row.shell.phase !== "current" ||
                row.shell.health !== "healthy"
              );
            })
          : wave[0];
      if (unhealthy !== undefined) {
        yield* action({ instanceId: unhealthy, action: "rollback" }).pipe(Effect.ignore);
        yield* publishRollout({
          ...started,
          phase: "failed",
          updatedAt: nowIso(),
          currentWave: waveIndex + 1,
          completedInstanceIds: completed.filter((id) => id !== unhealthy),
          failedInstanceId: unhealthy,
          errorCode: "health_observation_failed",
        });
        return;
      }
    }
    yield* publishRollout({
      ...started,
      phase: "completed",
      updatedAt: nowIso(),
      currentWave: waves.length,
      completedInstanceIds: completed,
    });
  });

  const startRollout = Effect.gen(function* () {
    const current = yield* SynchronizedRef.get(rolloutRef);
    if (runningPhases.has(current.phase)) {
      return { _tag: "already_running", status: current } as const;
    }
    const checking: CtoxShellFleetRolloutStatus = {
      ...initialRolloutStatus,
      phase: "inventory",
      startedAt: nowIso(),
      updatedAt: nowIso(),
    };
    yield* publishRollout(checking);
    const currentInventory = yield* inventory;
    if (currentInventory._tag !== "completed") {
      yield* publishRollout({
        ...checking,
        phase: "failed",
        updatedAt: nowIso(),
        errorCode: "inventory_failed",
      });
      return { _tag: "failed", code: "inventory_failed" } as const;
    }
    const waves = planCtoxShellRolloutWaves(currentInventory.rows);
    if (waves.length === 0) {
      yield* publishRollout({ ...checking, phase: "completed", updatedAt: nowIso() });
      return { _tag: "failed", code: "no_eligible_instances" } as const;
    }
    const ids = waves.flat();
    const releaseVersion =
      currentInventory.rows
        .map((row) => row.shell.latestCompatibleVersion)
        .find((version): version is string => version !== null) ?? null;
    const started: CtoxShellFleetRolloutStatus = {
      ...checking,
      releaseVersion,
      totalWaves: waves.length,
      instanceIds: ids,
    };
    yield* publishRollout(started);
    yield* executeRollout(waves, started).pipe(Effect.forkIn(parentScope));
    return { _tag: "started", status: started } as const;
  }).pipe(
    Effect.orElseSucceed(
      (): CtoxShellFleetRolloutResult => ({ _tag: "failed", code: "rollout_failed" }),
    ),
  );

  const subscribeRollout = (listener: (status: CtoxShellFleetRolloutStatus) => void) =>
    Effect.sync(() => {
      rolloutListeners.add(listener);
      return () => rolloutListeners.delete(listener);
    });

  yield* Effect.gen(function* () {
    yield* Effect.sleep(CTOX_SHELL_FLEET_ROLLOUT_POLICY.startupDelay);
    while (true) {
      yield* startRollout.pipe(Effect.ignore);
      yield* Effect.sleep(CTOX_SHELL_FLEET_ROLLOUT_POLICY.checkInterval);
    }
  }).pipe(Effect.forkIn(parentScope));

  return CtoxShellFleet.of({
    inventory,
    action,
    pause,
    resume,
    rolloutStatus: SynchronizedRef.get(rolloutRef),
    startRollout,
    subscribeRollout,
  });
});

export const layer = () => Layer.effect(CtoxShellFleet, make());
