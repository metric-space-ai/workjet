// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { CtoxAccountLifecycle } from "./CtoxAccountLifecycle.ts";
import { CtoxInstanceRegistry } from "./CtoxInstanceRegistry.ts";
import { resolveCtoxBinary } from "./CtoxLocalDaemonLaunch.ts";
import { makeCtoxSshInviteExec, type CtoxSshInviteExec } from "./CtoxSshManagedLaunch.ts";

const MAX_IDENTITY_BYTES = 4096;
const IDENTITY_TIMEOUT_MS = 20_000;
const SSH_FAILURE_MARKER = "__workjet_native_identity_failed__";

const IdentityDocument = Schema.Struct({
  identity: Schema.String.check(Schema.isPattern(/^ed25519:[0-9a-f]{64}$/)),
});
const decodeIdentity = Schema.decodeUnknownSync(IdentityDocument, { onExcessProperty: "error" });

export class CtoxNativeIdentityError extends Schema.TaggedErrorClass<CtoxNativeIdentityError>()(
  "CtoxNativeIdentityError",
  {},
) {
  override get message(): string {
    return "The selected CTOX instance has no verified native identity.";
  }
}

/** Public target pin from a trusted local/SSH source, not peer authentication or Ready. */
export interface CtoxNativeIdentity {
  readonly targetId: string;
  readonly instanceId: string;
  readonly publicIdentity: string;
  readonly sessionEpoch: number;
}

export class CtoxNativeIdentityResolver extends Context.Service<
  CtoxNativeIdentityResolver,
  {
    readonly resolve: (
      targetId: string,
    ) => Effect.Effect<CtoxNativeIdentity, CtoxNativeIdentityError>;
  }
>()("@workjet/desktop/ctox/CtoxNativeIdentityResolver") {}

export interface CtoxNativeIdentityResolverOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly sshExec?: CtoxSshInviteExec;
}

function parseIdentity(stdout: string): string {
  if (Buffer.byteLength(stdout, "utf8") > MAX_IDENTITY_BYTES) throw new CtoxNativeIdentityError();
  try {
    return decodeIdentity(JSON.parse(stdout)).identity;
  } catch {
    throw new CtoxNativeIdentityError();
  }
}

/** No init, invite minting, capability retrieval, or fallback to another root. */
export function buildCtoxSshIdentityCommand(stateRoot?: string): readonly string[] {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const root =
    stateRoot === undefined
      ? 'CTOX_ROOT="${CTOX_STATE_ROOT:-$HOME/.local/state/ctox}"'
      : `CTOX_ROOT=${quote(stateRoot)}`;
  return [
    "sh",
    "-c",
    `${root}; { "\${CTOX_BIN:-ctox}" sync identity --root "$CTOX_ROOT" 2>/dev/null || ` +
      `echo '${SSH_FAILURE_MARKER}' >&2; } | head -c ${MAX_IDENTITY_BYTES + 1}`,
  ];
}

const readLocalIdentity = Effect.fn("CtoxNativeIdentityResolver.readLocalIdentity")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  stateRoot: string,
) {
  const child = yield* spawner.spawn(
    ChildProcess.make(command, ["sync", "identity", "--root", stateRoot]),
  );
  const [stdout, , exitCode] = yield* Effect.all(
    [
      child.stdout.pipe(
        Stream.runFoldEffect(
          () => Buffer.alloc(0),
          (current, chunk) =>
            current.byteLength + chunk.byteLength > MAX_IDENTITY_BYTES
              ? Effect.fail(new CtoxNativeIdentityError())
              : Effect.succeed(Buffer.concat([current, chunk])),
        ),
      ),
      Stream.runDrain(child.stderr),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  if (Number(exitCode) !== 0) return yield* new CtoxNativeIdentityError();
  return yield* Effect.try({
    try: () => parseIdentity(stdout.toString("utf8")),
    catch: () => new CtoxNativeIdentityError(),
  });
});

export const make = Effect.fn("CtoxNativeIdentityResolver.make")(function* (
  options: CtoxNativeIdentityResolverOptions = {},
) {
  const registry = yield* CtoxInstanceRegistry;
  const account = yield* CtoxAccountLifecycle;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  // Reuse the existing pinned OpenSSH execution path and its secret owner.
  const sshExec = options.sshExec ?? makeCtoxSshInviteExec({ spawner, fileSystem, path });

  const read = Effect.fn("CtoxNativeIdentityResolver.read")(function* (targetId: string) {
    if (targetId.startsWith("local:")) {
      if (platform === "win32") return yield* new CtoxNativeIdentityError();
      const target = yield* registry.resolveLocalDaemonTarget(targetId);
      if (!target.stateRoot || !path.isAbsolute(target.stateRoot) || !target.daemonInstanceId) {
        return yield* new CtoxNativeIdentityError();
      }
      const publicIdentity = yield* readLocalIdentity(
        spawner,
        resolveCtoxBinary(env),
        target.stateRoot,
      ).pipe(Effect.scoped);
      return { targetId, instanceId: target.daemonInstanceId, publicIdentity };
    }
    if (targetId.startsWith("ssh:")) {
      const target = yield* registry.resolveSshManagedTarget(targetId);
      if (
        target.platform === "windows" ||
        !target.daemonInstanceId ||
        (target.stateRoot !== undefined && !path.isAbsolute(target.stateRoot))
      ) {
        return yield* new CtoxNativeIdentityError();
      }
      const output = yield* sshExec({
        host: target.host,
        ...(target.username === undefined ? {} : { username: target.username }),
        ...(target.port === undefined ? {} : { port: target.port }),
        ...(target.knownHostsLine === undefined ? {} : { knownHostsLine: target.knownHostsLine }),
        argv: buildCtoxSshIdentityCommand(target.stateRoot),
        timeoutMs: IDENTITY_TIMEOUT_MS,
      });
      if (output.stderr?.includes(SSH_FAILURE_MARKER)) return yield* new CtoxNativeIdentityError();
      const publicIdentity = yield* Effect.try({
        try: () => parseIdentity(output.stdout),
        catch: () => new CtoxNativeIdentityError(),
      });
      return { targetId, instanceId: target.daemonInstanceId, publicIdentity };
    }
    // Managed/QR enrollment must provide an independent pin before it can join.
    return yield* new CtoxNativeIdentityError();
  });

  return CtoxNativeIdentityResolver.of({
    resolve: (targetId) =>
      Effect.tryPromise({
        try: (callerSignal) => {
          const cancellation = new AbortController();
          let pending: Promise<CtoxNativeIdentity> | undefined;
          // Registration rejects an in-progress/failed account transition.
          // Register and capture synchronously before the first native read.
          const unregister = account.registerInvalidator(async () => {
            cancellation.abort();
            await pending?.then(
              () => undefined,
              () => undefined,
            );
          });
          const sessionEpoch = account.sessionEpoch();
          const signal = AbortSignal.any([callerSignal, cancellation.signal]);
          pending = Effect.runPromise(
            read(targetId).pipe(
              Effect.timeout(IDENTITY_TIMEOUT_MS),
              Effect.flatMap((identity) => {
                if (signal.aborted || account.sessionEpoch() !== sessionEpoch) {
                  return Effect.fail(new CtoxNativeIdentityError());
                }
                return Effect.succeed({ ...identity, sessionEpoch });
              }),
            ),
            { signal },
          );
          return pending.finally(unregister);
        },
        catch: () => new CtoxNativeIdentityError(),
      }),
  });
});

export const layer = (options: CtoxNativeIdentityResolverOptions = {}) =>
  Layer.effect(CtoxNativeIdentityResolver, make(options));
