// @effect-diagnostics nodeBuiltinImport:off -- Desktop's bounded OS connection boundary.
// @effect-diagnostics globalDate:off globalDateInEffect:off -- Snapshot timestamps only.
// @effect-diagnostics anyUnknownInErrorContext:off -- External SSH errors are reduced at the IPC boundary.
import * as Fsp from "node:fs/promises";
import * as Path from "node:path";
import type { RpcSession } from "@workjet/client-runtime/rpc";
import {
  EnvironmentId,
  WorkjetComputerId,
  CommandId,
  WS_METHODS,
  type CtoxWorkjetComputerControlResult,
  type CtoxWorkjetComputerControlRequest,
  type ComputerConnection,
  type ComputerControlInput,
  type ComputerControlResult,
  type ComputerSshKeyInfo,
  type WorkjetComputer,
  type WorkjetConfiguration,
} from "@workjet/contracts";
import { runSshCommand, parseSshResolveOutput, buildSshHostSpec } from "@workjet/ssh/command";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as FileSystem from "effect/FileSystem";
import * as EffectPath from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { DesktopBackendPool } from "../backend/DesktopBackendPool.ts";
import { DesktopLocalServiceSession } from "../backend/DesktopLocalServiceSession.ts";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { CtoxGuestManager } from "../ctox/CtoxGuestManager.ts";
import * as Crypto from "effect/Crypto";
import { runLocalCommand } from "../provisioning/LocalProvisioningCommand.ts";
import { COMPUTER_PROBE_SCRIPT, parseComputerProbe } from "./ComputerProbe.ts";
import { computerCleanupScript, computerCleanupPaths } from "./ComputerCleanup.ts";
import {
  defaultComputerMetadata,
  reconcileComputer,
  migrateComputerRecords,
} from "./computerRegistry.ts";

export class ComputerBackendError extends Schema.TaggedErrorClass<ComputerBackendError>()(
  "ComputerBackendError",
  { operation: Schema.String },
) {}
export class DesktopComputers extends Context.Service<
  DesktopComputers,
  {
    readonly control: (
      input: ComputerControlInput,
    ) => Effect.Effect<ComputerControlResult, ComputerBackendError>;
    readonly onConnected: (
      input: Extract<ComputerControlInput, { _tag: "add" }>,
    ) => Effect.Effect<void>;
    readonly assign: (
      id: string,
      instanceId: string,
    ) => Effect.Effect<CtoxWorkjetComputerControlResult, ComputerBackendError>;
    readonly sshKeys: Effect.Effect<readonly ComputerSshKeyInfo[], ComputerBackendError>;
  }
>()("@workjet/desktop/computers/DesktopComputers") {}

export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool;
  const sessions = yield* DesktopLocalServiceSession;
  const environment = yield* DesktopEnvironment;
  const runtime = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | EffectPath.Path
  >();
  const scope = yield* Scope.Scope;
  const crypto = yield* Crypto.Crypto;
  const guests = yield* CtoxGuestManager;
  const mutex = yield* Semaphore.make(1);
  const running = new Set<string>();
  const withSession = <A, E, R>(use: (session: RpcSession) => Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const primary = yield* pool.primary;
        const config = yield* primary.currentConfig;
        if (Option.isNone(config))
          return yield* new ComputerBackendError({ operation: "local backend unavailable" });
        const session = yield* sessions.attach(config.value);
        yield* session.ready;
        return yield* use(session);
      }),
    );
  const read = () =>
    withSession((rpc) => rpc.client[WS_METHODS.serverGetSettings]({})).pipe(
      Effect.map((settings) => settings.workjet),
    );
  const write = (workjet: WorkjetConfiguration, expectedWorkjet: WorkjetConfiguration) =>
    withSession((rpc) =>
      rpc.client[WS_METHODS.serverUpdateSettings]({ patch: { workjet }, expectedWorkjet }),
    ).pipe(Effect.asVoid);
  const local = (command: string, args: readonly string[], stdin?: string, timeout = 8000) =>
    Effect.tryPromise(() => runLocalCommand(command, args, stdin, timeout));
  const execute = (connection: ComputerConnection, script: string, timeout = 75_000) =>
    connection._tag === "local"
      ? local("sh", ["-s"], script, timeout)
      : runSshCommand(connection.target, {
          batchMode: "yes",
          preHostArgs: ["-o", "StrictHostKeyChecking=yes"],
          remoteCommandArgs: ["sh", "-s"],
          stdin: script,
          timeoutMs: timeout,
        }).pipe(Effect.provide(runtime));
  const detect = (computer: WorkjetComputer) =>
    Effect.gen(function* () {
      const metadata = computer.metadata!;
      if (!metadata.connection)
        return yield* new ComputerBackendError({
          operation: "saved connection unavailable; reconnect this computer",
        });
      let connection = metadata.connection;
      let identityFiles = metadata.identityFiles;
      let fingerprint = metadata.hostKeyFingerprint;
      if (connection._tag !== "local") {
        const destination = connection.target.alias.trim() || connection.target.hostname.trim();
        if (!destination || destination.startsWith("-") || /[\r\n\u0000]/u.test(destination))
          return yield* new ComputerBackendError({ operation: "invalid SSH destination" });
        const resolved = yield* local("ssh", [
          "-G",
          ...(connection.target.port === null ? [] : ["-p", String(connection.target.port)]),
          ...(connection.target.username === null ? [] : ["-l", connection.target.username]),
          destination,
        ]);
        const target = parseSshResolveOutput(connection.target.alias, resolved.stdout);
        connection = { ...connection, target };
        identityFiles = resolved.stdout
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("identityfile "))
          .map((line) => line.slice(13));
        const aliasLine = resolved.stdout
          .split(/\r?\n/u)
          .find((line) => line.startsWith("hostkeyalias "));
        const keyHost =
          aliasLine?.slice(13) ||
          (target.port === 22 || target.port === null
            ? target.hostname
            : "[" + target.hostname + "]:" + target.port);
        const known = yield* local("ssh-keygen", ["-F", keyHost]).pipe(Effect.option);
        if (Option.isSome(known)) {
          const publicLines = known.value.stdout
            .split(/\r?\n/u)
            .filter((line) => line && !line.startsWith("#"));
          if (publicLines.length) {
            const keys = yield* local(
              "ssh-keygen",
              ["-lf", "-", "-E", "sha256"],
              publicLines.join("\n") + "\n",
            );
            fingerprint = keys.stdout.trim().split(/\s+/u)[1] ?? fingerprint;
          }
        }
        // buildSshHostSpec validates the resolved destination while preserving alias/ProxyJump/IdentityFile.
        buildSshHostSpec(target);
      }
      const output = yield* execute(connection, COMPUTER_PROBE_SCRIPT);
      const facts = parseComputerProbe(output.stdout, output.stderr);
      return {
        ...computer,
        metadata: {
          ...metadata,
          connection,
          facts,
          identityFiles,
          hostKeyFingerprint: fingerprint,
          status: "ready" as const,
          error: null,
        },
      };
    });
  const rows = (configuration: WorkjetConfiguration): ComputerControlResult["computers"] =>
    configuration.computers.map((computer) => ({
      id: computer.id,
      label: computer.label,
      environmentId: computer.environmentId,
      metadata:
        computer.metadata ??
        defaultComputerMetadata(computer.presentationKind === "local" ? { _tag: "local" } : null),
    }));
  const control = (input: ComputerControlInput) =>
    Effect.gen(function* () {
      let configuration = yield* read();
      let expectedWorkjet = configuration;
      const removedPaths: ComputerControlResult["removedPaths"][number][] = [];
      const needsMigration = configuration.computers.some((computer) => !computer.metadata);
      configuration = migrateComputerRecords(configuration);
      if (input._tag === "add" || input._tag === "recheck") {
        const computer =
          input._tag === "add"
            ? {
                id: WorkjetComputerId.make(input.id),
                label: input.label,
                environmentId: EnvironmentId.make(input.environmentId),
                presentationKind:
                  input.connection._tag === "local"
                    ? ("local" as const)
                    : input.connection._tag === "tailscale"
                      ? ("tailscale" as const)
                      : ("ssh" as const),
                harnesses:
                  configuration.computers.find((row) => row.id === input.id)?.harnesses ?? [],
                metadata: {
                  ...(configuration.computers.find((row) => row.id === input.id)?.metadata ??
                    defaultComputerMetadata(input.connection)),
                  connection: input.connection,
                },
              }
            : configuration.computers.find(
                (row) => row.id === input.id || row.metadata?.previousIds.includes(input.id),
              );
        if (!computer) return yield* new ComputerBackendError({ operation: "computer not found" });
        const result = yield* detect(computer).pipe(
          Effect.catch(() =>
            Effect.succeed({
              ...computer,
              metadata: {
                ...computer.metadata!,
                status: "unreachable" as const,
                error: "Computer detection failed; verify the existing connection and retry.",
              },
            }),
          ),
        );
        expectedWorkjet = yield* read();
        const current = migrateComputerRecords(expectedWorkjet);
        configuration = reconcileComputer(current, result);
      } else if (input._tag !== "list") {
        const computer = configuration.computers.find(
          (row) => row.id === input.id || row.metadata?.previousIds.includes(input.id),
        );
        if (!computer) return yield* new ComputerBackendError({ operation: "computer not found" });
        if (input._tag === "remove") {
          if (input.mode === "workjet-and-files") {
            if (
              !computer.metadata?.facts ||
              !computer.metadata.connection ||
              computer.metadata.connection._tag === "local"
            )
              return yield* new ComputerBackendError({
                operation:
                  "remote cleanup requires detected SSH facts; local cleanup is not supported",
              });
            const output = yield* execute(
              computer.metadata.connection,
              computerCleanupScript(computer.metadata.facts),
              20_000,
            );
            for (const line of output.stdout.split(/\r?\n/u)) {
              const [status, path] = line.split("\t");
              if (
                path &&
                (status === "removed" ||
                  status === "absent" ||
                  status === "refused" ||
                  status === "failed")
              )
                removedPaths.push({ path, status });
            }
            const allowed = computerCleanupPaths(computer.metadata.facts);
            if (
              removedPaths.length !== allowed.length ||
              new Set(removedPaths.map((row) => row.path)).size !== allowed.length ||
              removedPaths.some((row) => !allowed.includes(row.path))
            )
              return yield* new ComputerBackendError({
                operation: "cleanup returned invalid results; computer retained",
              });
            if (removedPaths.some((row) => row.status === "failed" || row.status === "refused"))
              return { computers: rows(configuration), removedPaths };
            expectedWorkjet = yield* read();
            configuration = migrateComputerRecords(expectedWorkjet);
          }
          configuration = {
            ...configuration,
            computers: configuration.computers.filter((row) => row.id !== computer.id),
            workerProfiles: configuration.workerProfiles,
            selectedComputerId:
              configuration.selectedComputerId === computer.id
                ? null
                : configuration.selectedComputerId,
          };
        } else {
          configuration = {
            ...configuration,
            computers: configuration.computers.map((row) =>
              row.id !== computer.id
                ? row
                : {
                    ...row,
                    metadata: {
                      ...row.metadata!,
                      ...(input._tag === "setActive"
                        ? { active: input.active }
                        : { roles: input.roles }),
                    },
                  },
            ),
          };
        }
      }
      if (input._tag !== "list" || needsMigration) yield* write(configuration, expectedWorkjet);
      return { computers: rows(configuration), removedPaths };
    }).pipe(
      mutex.withPermits(1),
      Effect.mapError((error) =>
        Schema.is(ComputerBackendError)(error)
          ? error
          : new ComputerBackendError({ operation: "computer control failed; reload and retry" }),
      ),
    );
  const sshKeys = Effect.tryPromise(async () => {
    const directory = Path.join(environment.homeDirectory, ".ssh");
    let names: string[];
    try {
      names = await Fsp.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const keys: ComputerSshKeyInfo[] = [];
    for (const name of names.filter((name) => name.endsWith(".pub")).slice(0, 100)) {
      const path = Path.join(directory, name);
      const info = await Fsp.lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const result = await runLocalCommand(
        "ssh-keygen",
        ["-lf", path, "-E", "sha256"],
        undefined,
        3000,
      ).catch(() => null);
      keys.push({
        path: path.slice(0, -4),
        publicKeyFingerprint: result?.stdout.trim().split(/\s+/u)[1] ?? null,
      });
    }
    return keys;
  }).pipe(
    Effect.mapError(
      () => new ComputerBackendError({ operation: "SSH public key inventory unavailable" }),
    ),
  );
  return DesktopComputers.of({
    control,
    sshKeys,
    assign: (id, instanceId) =>
      Effect.gen(function* () {
        const configuration = yield* read();
        const computer = configuration.computers.find(
          (row) => row.id === id || row.metadata?.previousIds.includes(id),
        );
        if (!computer?.metadata?.facts)
          return yield* new ComputerBackendError({
            operation: "detect the computer before assigning it",
          });
        const metadata = computer.metadata;
        const request: CtoxWorkjetComputerControlRequest = {
          action: "computer.assign",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          computerId: computer.id,
          displayName: computer.label,
          hostingMode: "workstation",
          capabilities: [
            ...computer.harnesses.filter((row) => row.available).map((row) => row.harness),
            ...(metadata.roles.build ? ["build"] : []),
            ...(metadata.roles.storage ? ["storage"] : []),
            ...(metadata.facts!.gpus.length ? ["gpu"] : []),
          ],
          roles: metadata.roles,
          active: metadata.active,
          detectedFacts: metadata.facts!,
          hostKeyFingerprint: metadata.hostKeyFingerprint,
          agentless: false,
          selfHostedColocation: false,
        };
        return yield* guests.requestComputerControl(instanceId, request);
      }).pipe(
        Effect.mapError(
          () => new ComputerBackendError({ operation: "detected computer assignment failed" }),
        ),
      ),
    onConnected: (input) =>
      Effect.gen(function* () {
        if (running.has(input.environmentId)) return;
        running.add(input.environmentId);
        yield* control(input).pipe(
          Effect.catch(() => Effect.logWarning("Computer detection could not persist its result.")),
          Effect.ensuring(Effect.sync(() => running.delete(input.environmentId))),
          Effect.forkIn(scope),
        );
      }),
  });
});
export const layer = Layer.effect(DesktopComputers, make);
