/**
 * Greppy hosted-session adapter.
 *
 * One `greppy agent serve` process owns the isolated workspace. Stdout is
 * the NDJSON event stream (the emitter flushes each line). Each control
 * call opens its own socket connection and does not subscribe, so replies
 * are not mixed with broadcasts. `turn.aborted` does not finish a Workjet
 * turn, so every terminal Greppy stop becomes `turn.completed`. The
 * `raw` field stays unset: its source union does not include Greppy.
 *
 * Serve cannot apply per turn, cannot take a wall-clock deadline, and
 * cannot switch models. A proposal ref is emitted on the result line when
 * the process exits. Resume passes that session id back; it does not
 * restore unapplied files from the previous isolated workspace.
 */
import * as NodeCrypto from "node:crypto";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ThreadId,
} from "@workjet/contracts";
import type { GreppySettings } from "@workjet/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  NO_PROCESS_STOP_RESULT,
  terminateProviderProcesses,
  trackedChildProcess,
  type ProviderAdapterShape,
  type ProviderTrackedProcess,
} from "../Services/ProviderAdapter.ts";
import { collectStreamAsString, isCommandMissingCause } from "../providerSnapshot.ts";
import { callGreppyRpc } from "../greppy/GreppyControl.ts";
import {
  GREPPY_DISABLED_MESSAGE,
  GREPPY_HTTPS_MESSAGE,
  GREPPY_MISSING_MESSAGE,
  GREPPY_MODEL_MESSAGE,
  GREPPY_PROPOSAL_REF,
  type GreppyNdjsonEvent,
  type GreppyResultEvent,
  type GreppyResumeCursor,
  type GreppyStopMapping,
  clampGreppyMaxTurns,
  classifyGreppyResult,
  classifyGreppyVersion,
  decodeGreppyResumeCursor,
  encodeGreppyResumeCursor,
  greppyIncompleteWarning,
  greppyProposalMessage,
  greppyServeArguments,
  greppyVersionRefusal,
  mapGreppyStop,
  parseGreppyNdjsonLine,
  plainHttpEndpoint,
  safeGreppyModelId,
} from "../greppy/GreppyProtocol.ts";

const PROVIDER = ProviderDriverKind.make("greppy");

const requestError = (method: string, detail: string, cause?: unknown) =>
  new ProviderAdapterRequestError({
    provider: "greppy",
    method,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const definedEnv = (env: NodeJS.ProcessEnv): Record<string, string | undefined> => {
  const next: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") next[key] = value;
  }
  return next;
};

interface LiveSession {
  threadId: ThreadId;
  fiber: Fiber.Fiber<void, unknown> | null;
  process: ProviderTrackedProcess | null;
  socketPath: string | null;
  sessionId: string | null;
  runId: string | null;
  project: string | null;
  model: string;
  runtimeMode: ProviderSession["runtimeMode"];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  binary: string;
  resumeCursor: GreppyResumeCursor | null;
  assistantText: string;
  activeTurnId: TurnId | null;
  promptId: string | null;
  turnOpen: boolean;
  sawTurnEvent: boolean;
  readyOk: boolean;
  readySettled: boolean;
  finished: boolean;
  stderr: string;
  lastError: string | null;
  versionWarning: string | null;
  session: ProviderSession | null;
  ready: Deferred.Deferred<void, ProviderAdapterRequestError>;
  stopped: Deferred.Deferred<void>;
}

export const makeGreppyAdapter = (
  config: GreppySettings,
  options: {
    readonly instanceId: ProviderInstanceId;
    readonly resolveSessionEnvironment: (
      model?: string,
    ) => Effect.Effect<NodeJS.ProcessEnv, ProviderAdapterError>;
  },
) =>
  Effect.gen(function* () {
    const ownerScope = yield* Effect.scope;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, LiveSession>();
    let rpcId = 1;

    const now = Effect.map(DateTime.now, DateTime.formatIso);
    const emit = (threadId: ThreadId, body: Omit<ProviderRuntimeEvent, "eventId" | "provider" | "providerInstanceId" | "threadId" | "createdAt">) =>
      Effect.gen(function* () {
        yield* PubSub.publish(events, {
          ...body,
          eventId: EventId.make(`greppy_${NodeCrypto.randomUUID()}`),
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          threadId,
          createdAt: yield* now,
        } as ProviderRuntimeEvent);
      });

    const collect = (command: ChildProcess.Command) =>
      Effect.gen(function* () {
        const child = yield* spawner.spawn(command);
        const [stdout, stderr, code] = yield* Effect.all(
          [
            collectStreamAsString(child.stdout),
            collectStreamAsString(child.stderr),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, code };
      }).pipe(Effect.scoped);

    const rpc = (session: LiveSession, method: string, params: Record<string, unknown>) => {
      const socketPath = session.socketPath;
      if (socketPath === null) {
        return Effect.fail(requestError(method, "Greppy has not opened a control socket yet."));
      }
      const id = rpcId;
      rpcId += 1;
      return callGreppyRpc({ socketPath, method, params, id });
    };

    const requireSession = (threadId: ThreadId) => {
      const session = sessions.get(threadId);
      return session && !session.finished
        ? Effect.succeed(session)
        : Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: "greppy",
              threadId,
            }),
          );
    };

    const failReady = (session: LiveSession, detail: string) =>
      Effect.gen(function* () {
        if (session.readySettled) return;
        session.readySettled = true;
        session.lastError = detail;
        yield* Deferred.fail(session.ready, requestError("startSession", detail)).pipe(Effect.ignore);
      });

    const succeedReady = (session: LiveSession) =>
      Effect.gen(function* () {
        if (session.readySettled) return;
        const createdAt = yield* now;
        const cursor = encodeGreppyResumeCursor({
          sessionId: session.sessionId ?? "",
          ...(session.runId ? { runId: session.runId } : {}),
          ...(session.project ? { project: session.project } : {}),
        });
        session.resumeCursor = cursor;
        session.session = {
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          status: "ready",
          runtimeMode: session.runtimeMode,
          ...(session.cwd ? { cwd: session.cwd } : {}),
          model: session.model,
          threadId: session.threadId,
          resumeCursor: cursor,
          createdAt,
          updatedAt: createdAt,
        };
        yield* emit(session.threadId, {
          type: "session.started",
          payload: {
            message: "Greppy session is ready.",
            resume: cursor,
          },
        });
        yield* emit(session.threadId, {
          type: "thread.started",
          payload: session.sessionId ? { providerThreadId: session.sessionId } : {},
        });
        yield* emit(session.threadId, {
          type: "session.state.changed",
          payload: { state: "ready", reason: "Greppy is idle." },
        });
        if (session.versionWarning) {
          yield* emit(session.threadId, {
            type: "runtime.warning",
            payload: { message: session.versionWarning },
          });
        }
        session.readyOk = true;
        session.readySettled = true;
        yield* Deferred.succeed(session.ready, undefined).pipe(Effect.ignore);
      });

    const completeTurn = (
      session: LiveSession,
      mapping: GreppyStopMapping,
      extras?: { readonly usage?: unknown; readonly errorMessage?: string },
    ) =>
      Effect.gen(function* () {
        if (!session.turnOpen || session.activeTurnId === null) return;
        const turnId = session.activeTurnId;
        const text = session.assistantText;
        session.turnOpen = false;
        session.activeTurnId = null;
        session.assistantText = "";
        if (text.trim().length > 0) {
          yield* emit(session.threadId, {
            type: "item.completed",
            turnId,
            itemId: RuntimeItemId.make(`greppy_assistant_${turnId}`),
            payload: {
              itemType: "assistant_message",
              status: mapping.state === "failed" ? "failed" : "completed",
              detail: text,
            },
          });
        }
        if (mapping.incomplete) {
          yield* emit(session.threadId, {
            type: "runtime.warning",
            turnId,
            payload: { message: greppyIncompleteWarning(mapping.stopReason) },
          });
        }
        yield* emit(session.threadId, {
          type: "turn.completed",
          turnId,
          payload: {
            state: mapping.state,
            stopReason: mapping.stopReason,
            ...(extras?.usage === undefined ? {} : { usage: extras.usage }),
            ...(extras?.errorMessage ? { errorMessage: extras.errorMessage } : {}),
          },
        });
        yield* emit(session.threadId, {
          type: "session.state.changed",
          payload: {
            state: mapping.state === "failed" ? "error" : "ready",
            ...(mapping.state === "failed" && extras?.errorMessage
              ? { reason: extras.errorMessage }
              : {}),
          },
        });
      });

    const finishFromResult = (session: LiveSession, result: GreppyResultEvent) =>
      Effect.gen(function* () {
        if (session.finished) return;
        if (!session.readyOk) {
          yield* failReady(
            session,
            session.lastError ??
              result.applyError ??
              `Greppy exited before the session was ready (status ${result.status}, code ${result.exitCode}).`,
          );
          session.finished = true;
          return;
        }
        session.finished = true;
        const classified = classifyGreppyResult(result);
        if (session.turnOpen) {
          yield* completeTurn(session, classified.turn, {
            ...(result.usage ? { usage: result.usage } : {}),
            ...(classified.turn.state === "failed"
              ? { errorMessage: session.lastError ?? classified.turn.stopReason }
              : {}),
          });
        }
        const proposal = greppyProposalMessage(result);
        if (proposal) {
          yield* emit(session.threadId, {
            type: "runtime.warning",
            payload: {
              message: proposal,
              ...(result.stat ? { detail: { stat: result.stat, proposalRef: result.proposalRef } } : {}),
            },
          });
        }
        if (result.patch && result.patch.trim().length > 0) {
          yield* emit(session.threadId, {
            type: "turn.diff.updated",
            payload: { unifiedDiff: result.patch },
          });
        }
        if (
          config.applyOnSessionStop &&
          result.proposalRef !== undefined &&
          GREPPY_PROPOSAL_REF.test(result.proposalRef)
        ) {
          const applied = yield* collect(
            ChildProcess.make(session.binary, ["agent", "apply", result.proposalRef], {
              cwd: session.cwd,
              env: definedEnv(session.env),
              extendEnv: false,
              shell: false,
            }),
          ).pipe(Effect.result);
          const message = Result.isFailure(applied)
            ? "Greppy could not run proposal apply."
            : applied.success.code === 0
              ? "Greppy applied the proposal onto the working tree. The git index is unchanged."
              : applied.success.code === 4
                ? "Greppy refused to apply the proposal because the checkout is dirty. The proposal ref is still there."
                : `Greppy proposal apply exited with code ${applied.success.code}. ${applied.success.stderr.trim()}`.trim();
          yield* emit(session.threadId, {
            type: "runtime.warning",
            payload: { message },
          });
        } else if (config.applyOnSessionStop && result.proposalRef !== undefined) {
          yield* emit(session.threadId, {
            type: "runtime.warning",
            payload: {
              message: "Greppy returned a proposal ref Workjet will not pass to apply.",
            },
          });
        }
        yield* emit(session.threadId, {
          type: "session.exited",
          payload: {
            exitKind: classified.exitKind,
            reason:
              classified.exitKind === "error"
                ? (session.lastError ?? `Greppy exited with status ${result.status}.`)
                : `Greppy finished with status ${result.status}.`,
          },
        });
        sessions.delete(session.threadId);
        yield* Deferred.succeed(session.stopped, undefined).pipe(Effect.ignore);
      });

    const handleEvent = (session: LiveSession, event: GreppyNdjsonEvent) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "session": {
            session.sessionId = event.sessionId;
            session.runId = event.runId ?? session.runId;
            session.project = event.project ?? session.project;
            session.socketPath = event.socket ?? session.socketPath;
            if (event.model) session.model = event.model;
            return;
          }
          case "phase": {
            if (event.phase === "idle" && session.sessionId && session.socketPath && !session.readyOk) {
              yield* succeedReady(session);
            }
            if (event.phase === "blocked" && !session.readyOk) {
              yield* failReady(
                session,
                session.lastError ?? "Greppy is blocked waiting for a model gateway.",
              );
            }
            return;
          }
          case "error": {
            session.lastError = event.message;
            yield* emit(session.threadId, {
              type: "runtime.error",
              ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
              payload: { message: event.message, class: "provider_error" },
            });
            if (!session.readyOk) {
              yield* failReady(session, event.message);
              return;
            }
            if (session.turnOpen) {
              yield* completeTurn(
                session,
                { state: "failed", incomplete: false, stopReason: "error" },
                { errorMessage: event.message },
              );
            }
            yield* emit(session.threadId, {
              type: "session.state.changed",
              payload: { state: "error", reason: event.message },
            });
            return;
          }
          case "turn_start": {
            session.sawTurnEvent = true;
            session.promptId = event.promptId ?? session.promptId;
            if (session.activeTurnId === null) {
              session.activeTurnId = TurnId.make(`greppy_${NodeCrypto.randomUUID()}`);
              session.turnOpen = true;
            }
            const turnId = session.activeTurnId;
            yield* emit(session.threadId, {
              type: "turn.started",
              turnId,
              ...(event.promptId ? { providerRefs: { providerTurnId: event.promptId } } : {}),
              payload: { model: session.model },
            });
            yield* emit(session.threadId, {
              type: "session.state.changed",
              payload: { state: "running" },
            });
            yield* emit(session.threadId, {
              type: "item.started",
              turnId,
              itemId: RuntimeItemId.make(`greppy_assistant_${turnId}`),
              payload: { itemType: "assistant_message", status: "inProgress" },
            });
            return;
          }
          case "text": {
            if (!session.turnOpen || session.activeTurnId === null || event.text.length === 0) return;
            session.assistantText += event.text;
            yield* emit(session.threadId, {
              type: "content.delta",
              turnId: session.activeTurnId,
              payload: { streamKind: "assistant_text", delta: event.text },
            });
            return;
          }
          case "tool_start": {
            if (session.activeTurnId === null) return;
            yield* emit(session.threadId, {
              type: "item.started",
              turnId: session.activeTurnId,
              itemId: RuntimeItemId.make(`greppy_tool_${event.id}`),
              payload: {
                itemType: "command_execution",
                status: "inProgress",
                title: event.name,
                ...(event.summary ? { detail: event.summary } : {}),
              },
            });
            return;
          }
          case "tool_finish": {
            if (session.activeTurnId === null) return;
            yield* emit(session.threadId, {
              type: "item.completed",
              turnId: session.activeTurnId,
              itemId: RuntimeItemId.make(`greppy_tool_${event.id}`),
              payload: {
                itemType: "command_execution",
                status: event.failed ? "failed" : "completed",
                ...(event.preview ? { detail: event.preview } : {}),
                data: { elapsedMs: event.elapsedMs ?? null, failed: event.failed },
              },
            });
            return;
          }
          case "turn_complete": {
            const mapping = mapGreppyStop(event.stop);
            yield* completeTurn(session, mapping, event.usage ? { usage: event.usage } : {});
            return;
          }
          case "result":
            yield* finishFromResult(session, event);
            return;
          case "unknown":
            return;
        }
      });

    const handleExit = (session: LiveSession, code: number) =>
      Effect.gen(function* () {
        if (session.finished) return;
        if (!session.readyOk) {
          const detail =
            session.lastError ??
            (session.stderr.trim() ||
              `Greppy exited with code ${code} before the session was ready.`);
          yield* failReady(session, detail);
          session.finished = true;
          return;
        }
        session.finished = true;
        const mapping = mapGreppyStop("", code);
        if (session.turnOpen) {
          yield* completeTurn(session, mapping.state === "completed" && code !== 0
            ? { state: "failed", incomplete: mapping.incomplete, stopReason: `exit ${code}` }
            : mapping, {
            ...(session.lastError ? { errorMessage: session.lastError } : {}),
          });
        }
        yield* emit(session.threadId, {
          type: "session.exited",
          payload: {
            exitKind: code === 0 || code === 5 || code === 130 ? "graceful" : "error",
            reason: session.lastError ?? `Greppy process exited with code ${code}.`,
          },
        });
        sessions.delete(session.threadId);
        yield* Deferred.succeed(session.stopped, undefined).pipe(Effect.ignore);
      });

    const pump = (session: LiveSession, child: ChildProcessSpawner.ChildProcessHandle) =>
      Effect.gen(function* () {
        yield* Effect.all(
          [
            Stream.runForEach(child.stdout.pipe(Stream.decodeText(), Stream.splitLines), (line) => {
              const parsed = parseGreppyNdjsonLine(line);
              return parsed === null ? Effect.void : handleEvent(session, parsed);
            }),
            Stream.runForEach(child.stderr.pipe(Stream.decodeText()), (chunk) =>
              Effect.sync(() => {
                session.stderr = (session.stderr + chunk).slice(-4000);
              }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const code = yield* child.exitCode.pipe(Effect.map(Number));
        yield* handleExit(session, code);
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        if (!config.enabled) {
          return yield* Effect.fail(requestError("startSession", GREPPY_DISABLED_MESSAGE));
        }
        if (sessions.has(input.threadId)) {
          return yield* Effect.fail(requestError("startSession", "This thread already has a Greppy session."));
        }
        const env = yield* options.resolveSessionEnvironment(input.modelSelection?.model ?? config.model);
        const envModel = typeof env.GREPPY_MODEL === "string" ? env.GREPPY_MODEL.trim() : "";
        const requestedModel =
          input.modelSelection?.model ?? (envModel.length > 0 ? envModel : config.model);
        const model = safeGreppyModelId(requestedModel);
        if (model === null) {
          return yield* Effect.fail(requestError("startSession", GREPPY_MODEL_MESSAGE));
        }
        const endpointSource =
          typeof env.GREPPY_ENDPOINT === "string" && env.GREPPY_ENDPOINT.trim().length > 0
            ? env.GREPPY_ENDPOINT
            : config.endpoint;
        const endpoint = plainHttpEndpoint(endpointSource);
        if (endpoint === null) {
          return yield* Effect.fail(requestError("startSession", GREPPY_HTTPS_MESSAGE));
        }
        const resume = decodeGreppyResumeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && resume === null) {
          return yield* Effect.fail(requestError(
            "startSession",
            "This resume cursor is not a Greppy session cursor.",
          ));
        }
        const binary = config.binaryPath || "greppy";
        const version = yield* collect(
          ChildProcess.make(binary, ["--version"], {
            env: definedEnv(env),
            extendEnv: false,
            shell: false,
          }),
        ).pipe(Effect.timeoutOption("8 seconds"), Effect.result);
        if (Result.isFailure(version)) {
          return yield* Effect.fail(requestError(
            "startSession",
            isCommandMissingCause(version.failure)
              ? GREPPY_MISSING_MESSAGE
              : "Failed to execute Greppy (`greppy --version`).",
            version.failure,
          ));
        }
        if (Option.isNone(version.success)) {
          return yield* Effect.fail(requestError("startSession", "Greppy `--version` timed out."));
        }
        if (version.success.value.code !== 0) {
          return yield* Effect.fail(requestError(
            "startSession",
            version.success.value.stderr.trim() ||
              `Greppy --version exited with code ${version.success.value.code}.`,
          ));
        }
        const versionClass = classifyGreppyVersion(version.success.value.stdout);
        if (versionClass.kind === "unsupported") {
          return yield* Effect.fail(requestError("startSession", greppyVersionRefusal(versionClass.version)));
        }

        const ready = yield* Deferred.make<void, ProviderAdapterRequestError>();
        const stopped = yield* Deferred.make<void>();
        const session: LiveSession = {
          threadId: input.threadId,
          fiber: null,
          process: null,
          socketPath: null,
          sessionId: null,
          runId: null,
          project: null,
          model,
          runtimeMode: input.runtimeMode,
          cwd: input.cwd,
          env,
          binary,
          resumeCursor: resume,
          assistantText: "",
          activeTurnId: null,
          promptId: null,
          turnOpen: false,
          sawTurnEvent: false,
          readyOk: false,
          readySettled: false,
          finished: false,
          stderr: "",
          lastError: null,
          versionWarning:
            versionClass.kind === "unparsed"
              ? "Greppy answered --version, but Workjet could not read a 0.4.x version."
              : null,
          session: null,
          ready,
          stopped,
        };
        const command = ChildProcess.make(
          binary,
          greppyServeArguments({
            model,
            endpoint,
            ...(resume ? { resumeSessionId: resume.sessionId } : {}),
            maxTurns: clampGreppyMaxTurns(config.maxTurns),
            noSandbox: config.noSandbox,
            skipSelfCheck: config.skipSelfCheck,
          }),
          {
            cwd: input.cwd,
            env: definedEnv(env),
            extendEnv: false,
            shell: false,
          },
        );
        const childReady = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle, ProviderAdapterRequestError>();
        const worker = Effect.gen(function* () {
          const child = yield* spawner.spawn(command);
          session.process = trackedChildProcess(child);
          yield* Deferred.succeed(childReady, child).pipe(Effect.orDie);
          yield* pump(session, child);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const detail = "Greppy failed to start.";
              yield* Deferred.fail(childReady, requestError("startSession", detail, cause)).pipe(
                Effect.ignore,
              );
              yield* failReady(session, detail);
            }),
          ),
        );
        const fiber = yield* Effect.forkIn(worker, ownerScope, { startImmediately: true });
        session.fiber = fiber;
        const spawned = yield* Deferred.await(childReady).pipe(
          Effect.timeoutOption("15 seconds"),
          Effect.result,
        );
        if (Result.isFailure(spawned) || Option.isNone(spawned.success)) {
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
          return yield* Effect.fail(
            Result.isFailure(spawned)
              ? spawned.failure
              : requestError("startSession", "Greppy did not start."),
          );
        }
        sessions.set(input.threadId, session);
        const becameReady = yield* Deferred.await(ready).pipe(
          Effect.timeoutOption("20 seconds"),
          Effect.result,
        );
        if (Result.isFailure(becameReady)) {
          sessions.delete(input.threadId);
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
          return yield* Effect.fail(becameReady.failure);
        }
        if (Option.isNone(becameReady.success)) {
          sessions.delete(input.threadId);
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
          const detail = session.stderr.trim();
          return yield* Effect.fail(requestError(
            "startSession",
            detail.length > 0 ? detail : "Greppy did not become ready.",
          ));
        }
        if (session.finished || session.session === null) {
          sessions.delete(input.threadId);
          return yield* Effect.fail(
            requestError("startSession", session.lastError ?? "Greppy exited during startup."),
          );
        }
        return session.session;
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const session = yield* requireSession(input.threadId);
        if ((input.attachments?.length ?? 0) > 0) {
          return yield* Effect.fail(requestError(
            "sendTurn",
            "Greppy does not accept attachments. Send the text of the turn only.",
          ));
        }
        const text = input.input?.trim() ?? "";
        if (text.length === 0) {
          return yield* Effect.fail(requestError("sendTurn", "Greppy needs a non-empty prompt."));
        }
        const requested = input.modelSelection?.model;
        if (requested !== undefined && safeGreppyModelId(requested) !== session.model) {
          return yield* Effect.fail(requestError(
            "sendTurn",
            "Greppy keeps the model chosen when the thread started. Start a new thread to use a different model.",
          ));
        }
        if (session.turnOpen) {
          return yield* Effect.fail(requestError("sendTurn", "Greppy is already running a turn on this thread."));
        }
        const turnId = TurnId.make(`greppy_${NodeCrypto.randomUUID()}`);
        session.activeTurnId = turnId;
        session.turnOpen = true;
        session.assistantText = "";
        session.sawTurnEvent = false;
        const accepted = yield* rpc(session, "turn/start", { text, source: "workjet" }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              if (!session.sawTurnEvent) {
                session.turnOpen = false;
                session.activeTurnId = null;
              }
            }),
          ),
        );
        const result = accepted.result;
        const acceptedOk =
          result !== null &&
          typeof result === "object" &&
          (result as { accepted?: unknown }).accepted === true;
        if (!acceptedOk) {
          if (!session.sawTurnEvent) {
            session.turnOpen = false;
            session.activeTurnId = null;
          }
          return yield* Effect.fail(requestError("sendTurn", "Greppy did not accept the turn."));
        }
        const cursor = session.resumeCursor ?? undefined;
        const started: ProviderTurnStartResult = {
          threadId: input.threadId,
          turnId,
          ...(cursor ? { resumeCursor: cursor } : {}),
        };
        return started;
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const session = yield* requireSession(threadId);
        yield* rpc(session, "turn/interrupt", {});
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        if (!session) return NO_PROCESS_STOP_RESULT;
        const processes = session.process ? [session.process] : [];
        return yield* terminateProviderProcesses({
          processes,
          cooperative: Effect.gen(function* () {
            if (session.socketPath !== null && !session.finished) {
              yield* rpc(session, "session/quit", {}).pipe(Effect.ignore);
            }
            yield* Deferred.await(session.stopped).pipe(Effect.timeoutOption("8 seconds"));
          }),
        });
      });

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: () =>
        Effect.fail(
          requestError(
            "respondToRequest",
            "Greppy has no approval protocol. Its sandbox confines tools, and Workjet cannot answer an approval for it.",
          ),
        ),
      respondToUserInput: () =>
        Effect.fail(
          requestError(
            "respondToUserInput",
            "Greppy does not ask structured questions.",
          ),
        ),
      stopSession,
      listSessions: () =>
        Effect.sync(() =>
          [...sessions.values()].flatMap((session) => (session.session ? [session.session] : [])),
        ),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId) && sessions.get(threadId)?.finished !== true),
      readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
      rollbackThread: () =>
        Effect.fail(
          requestError(
            "rollbackThread",
            "Greppy cannot roll a thread back. Resume restores the transcript only.",
          ),
        ),
      stopAll: () =>
        Effect.forEach(
          [...sessions.keys()],
          (threadId) => stopSession(threadId).pipe(Effect.ignore),
          { discard: true, concurrency: 1 },
        ),
      streamEvents: Stream.fromPubSub(events),
    };
    return adapter;
  });
