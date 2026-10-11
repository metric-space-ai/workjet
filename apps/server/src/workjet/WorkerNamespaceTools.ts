import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";
import { workerNamespaceSpawnInput, type WorkerNamespaceSpawnCapture } from "./WorkerNamespaceSpawn.ts";

const error = (cause: unknown) =>
  new AcpErrors.AcpTransportError({ detail: "Confined worker tool failed", cause });
const MAX_TEXT = 4 * 1024 * 1024;
const MAX_TERMINAL_OUTPUT = 1024 * 1024;

interface Output {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

/** Keep the newest bytes; decoding below removes a cut UTF-8 prefix. */
export const appendWorkerToolOutput = (old: Output, chunk: Uint8Array, limit: number): Output => {
  const length = old.bytes.length + chunk.length;
  const bytes = new Uint8Array(Math.min(length, limit));
  if (chunk.length >= bytes.length) {
    bytes.set(chunk.subarray(chunk.length - bytes.length));
  } else {
    bytes.set(old.bytes.subarray(old.bytes.length - (bytes.length - chunk.length)));
    bytes.set(chunk, bytes.length - chunk.length);
  }
  return { bytes, truncated: old.truncated || length > limit };
};

export const workerToolOutputText = (output: Output): string => {
  let start = 0;
  if (output.truncated) {
    while (start < output.bytes.length && (output.bytes[start]! & 0xc0) === 0x80) start++;
  }
  return new TextDecoder().decode(output.bytes.subarray(start));
};

interface Terminal {
  readonly scope: Scope.CloseableScope;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly done: Deferred.Deferred<AcpSchema.WaitForTerminalExitResponse, AcpErrors.AcpError>;
  output: Output;
  exitStatus?: AcpSchema.TerminalExitStatus;
}

type Operation =
  | { readonly kind: "read"; readonly path: string; readonly line?: number | null; readonly limit?: number | null }
  | { readonly kind: "write"; readonly path: string }
  | { readonly kind: "terminal"; readonly command: string; readonly args: ReadonlyArray<string>; readonly cwd: string; readonly env: Readonly<Record<string, string>> };

/** Always launch the captured helper in a fresh kernel namespace, never daemon FS or a host shell.
 * A capture is internal physical evidence, not an Owner/project execution-policy grant.
 */
export const makeWorkerNamespaceTools = (
  capture: WorkerNamespaceSpawnCapture,
  environment: Readonly<Record<string, string | undefined>>,
  authorizeSession: (sessionId: string) => Effect.Effect<void, AcpErrors.AcpError>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const terminals = new Map<string, Terminal>();
    const creation = yield* Semaphore.make(1);
    const close = (terminal: Terminal) =>
      Deferred.fail(terminal.done, error("Terminal released")).pipe(
        Effect.andThen(Scope.close(terminal.scope, Exit.void)),
      );
    yield* Effect.addFinalizer(() =>
      Effect.forEach(terminals.values(), close, { discard: true }).pipe(
        Effect.andThen(Effect.sync(() => terminals.clear())),
      ),
    );

    const spawn = Effect.fn("WorkerNamespaceTools.spawn")(function* (
      operation: Operation,
      stdin: ChildProcess.CommandInput = "ignore",
    ) {
      const wrapped = yield* Effect.try({
        try: () =>
          workerNamespaceSpawnInput(
            {
              command: "/run/workjet/helper",
              args: [
                "--worker-namespace-tools",
                JSON.stringify({
                  version: 1,
                  worktree: {
                    path: capture.worktree.worktreePath,
                    identity: { device: capture.worktree.worktreeDev, inode: capture.worktree.worktreeIno },
                  },
                  hostNetwork: capture.modelSocket.hostNetworkIdentity,
                  operation,
                }),
              ],
              cwd: capture.worktree.worktreePath,
              env: environment,
            },
            capture,
          ),
        catch: error,
      });
      return yield* spawner.spawn(
        ChildProcess.make(wrapped.command, wrapped.args, {
          cwd: wrapped.cwd,
          env: wrapped.env,
          extendEnv: false,
          stdin,
          killSignal: "SIGKILL",
        }),
      ).pipe(Effect.mapError(error));
    });

    const file = Effect.fn("WorkerNamespaceTools.file")(function* (
      operation: Operation,
      content?: string,
    ) {
      if (content !== undefined && new TextEncoder().encode(content).length > MAX_TEXT) {
        return yield* error("Tool text exceeds the write limit");
      }
      const child = yield* spawn(
        operation,
        content === undefined ? "ignore" : Stream.make(new TextEncoder().encode(content)),
      );
      const collect = (stream: Stream.Stream<Uint8Array, unknown>, limit: number) =>
        stream.pipe(
          Stream.runFold({ bytes: new Uint8Array(0), truncated: false } as Output,
            (old, chunk) => appendWorkerToolOutput(old, chunk, limit)),
          Effect.mapError(error),
        );
      const [stdout, stderr, code] = yield* Effect.all(
        [collect(child.stdout, 32 * 1024 * 1024), collect(child.stderr, 64 * 1024), child.exitCode.pipe(Effect.mapError(error))],
        { concurrency: "unbounded" },
      );
      if (code !== 0 || stdout.truncated) return yield* error(workerToolOutputText(stderr) || "Namespace tool exited unsuccessfully");
      return workerToolOutputText(stdout);
    });

    const fileRequest = (operation: Operation, content?: string) =>
      file(operation, content).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError(error),
        Effect.scoped,
      );

    const get = Effect.fn("WorkerNamespaceTools.getTerminal")(function* (sessionId: string, terminalId: string) {
      yield* authorizeSession(sessionId);
      const terminal = terminals.get(terminalId);
      if (!terminal) return yield* error("Unknown or released worker terminal");
      return terminal;
    });

    return {
      readTextFile: Effect.fn("WorkerNamespaceTools.readTextFile")(function* (request: AcpSchema.ReadTextFileRequest) {
        yield* authorizeSession(request.sessionId);
        const result = yield* fileRequest({ kind: "read", path: request.path, line: request.line, limit: request.limit });
        return yield* Effect.try({
          try: () => {
            const value: unknown = JSON.parse(result);
            if (value === null || typeof value !== "object" || !("content" in value) || typeof value.content !== "string") {
              throw new Error("Invalid namespace read result");
            }
            return { content: value.content };
          },
          catch: error,
        });
      }),
      writeTextFile: Effect.fn("WorkerNamespaceTools.writeTextFile")(function* (request: AcpSchema.WriteTextFileRequest) {
        yield* authorizeSession(request.sessionId);
        yield* fileRequest({ kind: "write", path: request.path }, request.content);
        return {};
      }),
      createTerminal: Effect.fn("WorkerNamespaceTools.createTerminal")(function* (request: AcpSchema.CreateTerminalRequest) {
        yield* authorizeSession(request.sessionId);
        return yield* creation.withPermit(Effect.gen(function* () {
          if (terminals.size >= 4) return yield* error("Worker terminal limit reached; release a terminal first");
          const cwd = request.cwd ?? capture.worktree.worktreePath;
          if ((cwd !== capture.worktree.worktreePath && !cwd.startsWith(capture.worktree.worktreePath + "/")) || cwd.split("/").includes("..")) {
            return yield* error("Terminal cwd is outside the captured worktree; escalation required");
          }
          const terminalId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(error));
          const scope = yield* Scope.make();
          const done = yield* Deferred.make<AcpSchema.WaitForTerminalExitResponse, AcpErrors.AcpError>();
          const child = yield* spawn({
            kind: "terminal",
            command: request.command,
            args: request.args ?? [],
            cwd,
            env: Object.fromEntries((request.env ?? []).map(({ name, value }) => [name, value])),
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          const terminal: Terminal = { scope, child, done, output: { bytes: new Uint8Array(0), truncated: false } };
          terminals.set(terminalId, terminal);
          const limit = Math.min(request.outputByteLimit ?? MAX_TERMINAL_OUTPUT, MAX_TERMINAL_OUTPUT);
          yield* Effect.all([
            child.all.pipe(
              Stream.runForEach((chunk) => Effect.sync(() => { terminal.output = appendWorkerToolOutput(terminal.output, chunk, limit); })),
              Effect.mapError(error),
            ),
            child.exitCode.pipe(
              Effect.mapError(error),
              Effect.tap((exitCode) => Effect.sync(() => { terminal.exitStatus = { exitCode }; })),
            ),
          ], { concurrency: "unbounded" }).pipe(
            Effect.map(([, exitCode]) => ({ exitCode })),
            Deferred.into(done),
            Effect.forkIn(scope),
          );
          yield* Effect.sleep("10 minutes").pipe(
            Effect.andThen(child.isRunning),
            Effect.flatMap((running) => running ? child.kill({ killSignal: "SIGKILL" }) : Effect.void),
            Effect.ignore,
            Effect.forkIn(scope),
          );
          return { terminalId };
        }));
      }),
      terminalOutput: Effect.fn("WorkerNamespaceTools.terminalOutput")(function* (request: AcpSchema.TerminalOutputRequest) {
        const terminal = yield* get(request.sessionId, request.terminalId);
        return { output: workerToolOutputText(terminal.output), truncated: terminal.output.truncated, ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}) };
      }),
      terminalWaitForExit: Effect.fn("WorkerNamespaceTools.terminalWaitForExit")(function* (request: AcpSchema.WaitForTerminalExitRequest) {
        return yield* Deferred.await((yield* get(request.sessionId, request.terminalId)).done);
      }),
      terminalKill: Effect.fn("WorkerNamespaceTools.terminalKill")(function* (request: AcpSchema.KillTerminalRequest) {
        const terminal = yield* get(request.sessionId, request.terminalId);
        if (yield* terminal.child.isRunning.pipe(Effect.mapError(error))) {
          yield* terminal.child.kill({ killSignal: "SIGTERM" }).pipe(Effect.mapError(error));
          yield* Deferred.await(terminal.done).pipe(
            Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => terminal.child.kill({ killSignal: "SIGKILL" }).pipe(Effect.mapError(error), Effect.andThen(Deferred.await(terminal.done))) }),
          );
        }
        return {};
      }),
      terminalRelease: Effect.fn("WorkerNamespaceTools.terminalRelease")(function* (request: AcpSchema.ReleaseTerminalRequest) {
        const terminal = yield* get(request.sessionId, request.terminalId);
        terminals.delete(request.terminalId);
        yield* close(terminal);
        return {};
      }),
    };
  });
