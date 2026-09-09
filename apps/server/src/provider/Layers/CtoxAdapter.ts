// @effect-diagnostics nodeBuiltinImport:off -- Stable native turn/event ids; no CLI process is started.
import * as NodeCrypto from "node:crypto";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  type WorkjetConnectionId,
} from "@workjet/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { makeCtoxNativeTaskClient } from "../../workjet/ctox/CtoxNativeTaskClient.ts";

export const CTOX_NATIVE_MODEL = "instance-default";
const provider = ProviderDriverKind.make("ctox");
type NativeClient = ReturnType<typeof makeCtoxNativeTaskClient>;
type NativeTurn = NonNullable<Effect.Success<ReturnType<NativeClient["latestNativeTurn"]>>>;
export interface CtoxTaskScope {
  readonly module_id: string;
  readonly record_id?: string;
}
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const Cursor = Schema.Struct({
  kind: Schema.Literal("ctox-native"),
  version: Schema.Literal(1),
  instanceId: Schema.String,
  connectionId: Schema.String,
  moduleId: Schema.String,
  recordId: Schema.NullOr(Schema.String),
});
const decodeCursor = Schema.decodeUnknownEffect(Cursor);
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const turnIdFor = (commandId: string) => TurnId.make(`ctox_${hash(commandId)}`);
const failure = (method: string, detail: string) =>
  new ProviderAdapterRequestError({ provider: "ctox", method, detail });
const mapFailure = (method: string) => (cause: unknown) =>
  failure(
    method,
    typeof cause === "object" &&
      cause !== null &&
      "reason" in cause &&
      typeof cause.reason === "string"
      ? `CTOX: ${cause.reason}`
      : "CTOX request failed; native work may still be running.",
  );
const terminal = (state: string): state is "completed" | "failed" | "cancelled" =>
  state === "completed" || state === "failed" || state === "cancelled";
type EventBody<E = ProviderRuntimeEvent> = E extends ProviderRuntimeEvent
  ? Omit<E, "eventId" | "provider" | "providerInstanceId" | "threadId" | "createdAt">
  : never;

/** An observation/session adapter for an existing daemon. Scope resolution is
 * server-owned; a client cannot supply a module or retarget this adapter.
 * Factory/selector integration supplies the selected instance and project link.
 */
export const makeCtoxAdapter = (options: {
  readonly instanceId: ProviderInstanceId;
  readonly ctoxInstanceId: string;
  readonly connectionId: WorkjetConnectionId;
  readonly client: NativeClient;
  readonly resolveTaskScope: (
    threadId: ThreadId,
  ) => Effect.Effect<CtoxTaskScope, ProviderAdapterError>;
}) =>
  Effect.gen(function* () {
    const ownerScope = yield* Effect.scope;
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    interface Entry {
      session: ProviderSession;
      taskScope: CtoxTaskScope;
      submitting: boolean;
      turn: NativeTurn | null;
      observer?: Fiber.Fiber<void>;
    }
    const sessions = new Map<ThreadId, Entry>();
    const scopeFor = (threadId: ThreadId) => ({
      threadId,
      connectionId: options.connectionId,
      instanceId: options.ctoxInstanceId,
    });
    const cursorFor = (task: CtoxTaskScope) => ({
      kind: "ctox-native" as const,
      version: 1 as const,
      instanceId: options.ctoxInstanceId,
      connectionId: options.connectionId,
      moduleId: task.module_id,
      recordId: task.record_id ?? null,
    });
    const emit = (threadId: ThreadId, body: EventBody) =>
      Effect.gen(function* () {
        const encoded = yield* encode(body).pipe(Effect.orDie);
        yield* PubSub.publish(events, {
          ...body,
          eventId: EventId.make(
            `ctox_${body.turnId ? hash(`${threadId}:${encoded}`) : NodeCrypto.randomUUID()}`,
          ),
          provider,
          providerInstanceId: options.instanceId,
          threadId,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        } as ProviderRuntimeEvent);
      });
    const requireEntry = (threadId: ThreadId) => {
      const entry = sessions.get(threadId);
      return entry
        ? Effect.succeed(entry)
        : Effect.fail(failure("session", "Native CTOX session is not open."));
    };
    const checkScope = (entry: Entry, turn: NativeTurn) => {
      const request = turn.reference.request;
      return request.operation === "delegate_task" &&
        request.module_id === entry.taskScope.module_id &&
        (request.record_id ?? null) === (entry.taskScope.record_id ?? null)
        ? Effect.void
        : Effect.fail(failure("resume", "The native turn belongs to another module or record."));
    };
    const observe = (threadId: ThreadId, entry: Entry, turn: NativeTurn) =>
      Effect.gen(function* () {
        const commandId = turn.reference.commandId;
        if (!commandId) return;
        const turnId = turnIdFor(commandId);
        const itemId = RuntimeItemId.make(`ctox_${hash(commandId)}`);
        yield* emit(threadId, {
          type: "turn.started",
          turnId,
          providerRefs: { providerTurnId: commandId },
          payload: {},
        });
        yield* emit(threadId, {
          type: "item.started",
          turnId,
          itemId,
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
        let previous = "";
        let errors = 0;
        while (sessions.get(threadId) === entry && entry.turn?.requestKey === turn.requestKey) {
          const result = yield* options.client
            .readStatus({ ...scopeFor(threadId), requestKey: turn.requestKey })
            .pipe(Effect.result);
          if (result._tag === "Failure") {
            errors += 1;
            if (errors >= 3) {
              entry.session = {
                ...entry.session,
                status: "error",
                lastError: "CTOX observation paused. The native task continues in Ops.",
              };
              yield* emit(threadId, {
                type: "session.state.changed",
                payload: { state: "error", reason: entry.session.lastError },
              });
              return;
            }
          } else {
            errors = 0;
            const observed = result.success;
            const snapshot = yield* encode({
              state: observed.state,
              status: observed.status,
              note: observed.note,
              result: observed.result,
            }).pipe(Effect.orDie);
            if (snapshot !== previous) {
              previous = snapshot;
              const resultText =
                observed.result == null
                  ? ""
                  : typeof observed.result === "string"
                    ? observed.result
                    : yield* encode(observed.result).pipe(Effect.orDie);
              const text =
                [observed.note, resultText].filter(Boolean).join("\n").slice(0, 16_000) ||
                `CTOX: ${observed.status ?? "outcome unknown"}`;
              yield* emit(threadId, {
                type: "content.delta",
                turnId,
                itemId,
                payload: { streamKind: "assistant_text", delta: `${text}\n` },
              });
              yield* emit(threadId, {
                type: "session.state.changed",
                payload: {
                  state:
                    observed.state === "waiting" || observed.state === "unknown"
                      ? "waiting"
                      : "running",
                },
              });
            }
            if (terminal(observed.state)) {
              yield* emit(threadId, {
                type: "item.completed",
                turnId,
                itemId,
                payload: {
                  itemType: "assistant_message",
                  status: observed.state === "completed" ? "completed" : "failed",
                  data: {
                    ctox: {
                      instanceId: options.ctoxInstanceId,
                      commandId,
                      taskId: turn.reference.taskId,
                    },
                  },
                },
              });
              yield* emit(threadId, {
                type: "turn.completed",
                turnId,
                payload: { state: observed.state },
              });
              const { activeTurnId: _, lastError: __, ...session } = entry.session;
              entry.session = {
                ...session,
                status: "ready",
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              };
              yield* emit(threadId, { type: "session.state.changed", payload: { state: "ready" } });
              return;
            }
          }
          yield* Effect.sleep("2 seconds");
        }
      });
    const startObserver = (threadId: ThreadId, entry: Entry, turn: NativeTurn) =>
      Effect.gen(function* () {
        // Dev can close while a submission is still in flight: `sendTurn` holds
        // this entry across its network calls, and `stopSession` meanwhile
        // removes it from `sessions`, interrupts its observer and emits
        // `session.exited`. Re-arming here would flip that closed session back
        // to "running" and fork a fiber into the owner scope that no one is
        // watching. Observation is the only thing being dropped — the native
        // task keeps running and stays visible in Ops, which is the point.
        if (sessions.get(threadId) !== entry) return;
        if (entry.observer) yield* Fiber.interrupt(entry.observer);
        entry.turn = turn;
        entry.session = {
          ...entry.session,
          status: "running",
          ...(turn.reference.commandId
            ? { activeTurnId: turnIdFor(turn.reference.commandId) }
            : {}),
        };
        entry.observer = yield* observe(threadId, entry, turn).pipe(Effect.forkIn(ownerScope));
      });
    const stopSession = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const entry = sessions.get(threadId);
        if (!entry) return;
        sessions.delete(threadId);
        if (entry.observer) yield* Fiber.interrupt(entry.observer);
        yield* emit(threadId, {
          type: "session.exited",
          payload: {
            reason: "Dev observation closed; native work remains in Ops.",
            recoverable: true,
          },
        });
      });
    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession: (input) =>
        Effect.gen(function* () {
          if (input.providerInstanceId && input.providerInstanceId !== options.instanceId)
            return yield* failure("startSession", "Provider instance mismatch.");
          if (input.modelSelection && input.modelSelection.model !== CTOX_NATIVE_MODEL)
            return yield* failure(
              "startSession",
              "CTOX uses the model configuration of its own instance.",
            );
          const taskScope = yield* options.resolveTaskScope(input.threadId);
          const cursor = cursorFor(taskScope);
          if (input.resumeCursor !== undefined) {
            const resumed = yield* decodeCursor(input.resumeCursor).pipe(
              Effect.mapError(mapFailure("resume")),
            );
            if (
              resumed.instanceId !== cursor.instanceId ||
              resumed.connectionId !== cursor.connectionId ||
              resumed.moduleId !== cursor.moduleId ||
              resumed.recordId !== cursor.recordId
            )
              return yield* failure(
                "resume",
                "The native session cannot move to another instance, module or record.",
              );
          }
          const existing = sessions.get(input.threadId);
          if (existing) {
            if (
              existing.taskScope.module_id !== taskScope.module_id ||
              (existing.taskScope.record_id ?? null) !== (taskScope.record_id ?? null)
            )
              return yield* failure(
                "startSession",
                "An open native session cannot change its task scope.",
              );
            return existing.session;
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const entry: Entry = {
            taskScope,
            submitting: false,
            turn: null,
            session: {
              provider,
              providerInstanceId: options.instanceId,
              threadId: input.threadId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              model: CTOX_NATIVE_MODEL,
              resumeCursor: cursor,
              ...(input.cwd ? { cwd: input.cwd } : {}),
              createdAt: now,
              updatedAt: now,
            },
          };
          let latest = yield* options.client
            .latestNativeTurn(scopeFor(input.threadId))
            .pipe(Effect.mapError(mapFailure("resume")));
          if (latest) {
            yield* checkScope(entry, latest);
            if (!latest.reference.commandId) {
              const replay = yield* options.client
                .submit(
                  { ...scopeFor(input.threadId), requestKey: latest.requestKey },
                  latest.reference.request,
                )
                .pipe(Effect.mapError(mapFailure("resume")));
              latest = { ...latest, reference: replay.reference };
            }
          }
          sessions.set(input.threadId, entry);
          yield* emit(input.threadId, { type: "session.started", payload: { resume: cursor } });
          if (latest) yield* startObserver(input.threadId, entry, latest);
          return entry.session;
        }),
      sendTurn: (input) =>
        Effect.gen(function* () {
          const entry = yield* requireEntry(input.threadId);
          if (entry.submitting)
            return yield* failure("sendTurn", "A native submission is already in progress.");
          if (
            !input.requestId ||
            !input.input?.trim() ||
            input.input.length > 16_000 ||
            (input.attachments?.length ?? 0) > 0
          )
            return yield* failure(
              "sendTurn",
              "A native turn requires its persisted request id and text (up to 16000 characters); file transfer is not configured.",
            );
          if (input.modelSelection && input.modelSelection.model !== CTOX_NATIVE_MODEL)
            return yield* failure(
              "sendTurn",
              "CTOX uses the model configuration of its own instance.",
            );
          entry.submitting = true;
          return yield* Effect.gen(function* () {
            const latest = yield* options.client
              .latestNativeTurn(scopeFor(input.threadId))
              .pipe(Effect.mapError(mapFailure("sendTurn")));
            if (latest) {
              yield* checkScope(entry, latest);
              if (latest.requestId !== input.requestId) {
                const state = yield* options.client
                  .readStatus({ ...scopeFor(input.threadId), requestKey: latest.requestKey })
                  .pipe(Effect.mapError(mapFailure("sendTurn")));
                if (!terminal(state.state))
                  return yield* failure(
                    "sendTurn",
                    "The previous native task is still running or unresolved. Continue it in Ops or resume this turn.",
                  );
              }
            }
            const submitted = yield* options.client
              .submitTurn(scopeFor(input.threadId), input.requestId!, {
                ...entry.taskScope,
                title: input.input!.trim().split("\n")[0]!.slice(0, 200),
                objective: input.input!,
              })
              .pipe(Effect.mapError(mapFailure("sendTurn")));
            const native = yield* options.client
              .latestNativeTurn(scopeFor(input.threadId))
              .pipe(Effect.mapError(mapFailure("sendTurn")));
            if (!native || !submitted.reference.commandId)
              return yield* failure("sendTurn", "Native task receipt is missing.");
            yield* startObserver(input.threadId, entry, native);
            return {
              threadId: input.threadId,
              turnId: turnIdFor(submitted.reference.commandId),
              resumeCursor: entry.session.resumeCursor,
            };
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                entry.submitting = false;
              }),
            ),
          );
        }),
      stopSession,
      stopAll: () => Effect.forEach([...sessions.keys()], stopSession, { discard: true }),
      listSessions: () => Effect.sync(() => [...sessions.values()].map(({ session }) => session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) =>
        Effect.gen(function* () {
          yield* requireEntry(threadId);
          const latest = yield* options.client
            .latestNativeTurn(scopeFor(threadId))
            .pipe(Effect.mapError(mapFailure("readThread")));
          return {
            threadId,
            turns: latest?.reference.commandId
              ? [
                  {
                    id: turnIdFor(latest.reference.commandId),
                    items: [{ type: "ctox_task", ...latest.reference }],
                  },
                ]
              : [],
          };
        }),
      interruptTurn: () =>
        Effect.fail(
          failure(
            "interruptTurn",
            "Native cancellation must be performed in Ops; closing Dev does not cancel the task.",
          ),
        ),
      respondToRequest: () =>
        Effect.fail(failure("respondToRequest", "Resolve the native approval in Ops.")),
      respondToUserInput: () =>
        Effect.fail(failure("respondToUserInput", "Respond to the native task in Ops.")),
      rollbackThread: () =>
        Effect.fail(
          failure(
            "rollbackThread",
            "Native task history is durable and cannot be rolled back by a Dev session.",
          ),
        ),
      streamEvents: Stream.fromPubSub(events),
    };
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...sessions.keys()], stopSession, { discard: true }),
    );
    return adapter;
  });
