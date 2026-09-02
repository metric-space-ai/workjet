/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStopResult,
  ProviderSessionStartInput,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderTrackedProcess {
  readonly pid: number;
  readonly isRunning: Effect.Effect<boolean>;
  readonly kill: (signal: "SIGTERM" | "SIGKILL") => Effect.Effect<void>;
}

export const NO_PROCESS_STOP_RESULT: ProviderSessionStopResult = {
  terminated: true,
  method: "cooperative",
  pids: [],
};

export function trackedChildProcess(
  handle: ChildProcessSpawner.ChildProcessHandle,
): ProviderTrackedProcess {
  return {
    pid: Number(handle.pid),
    isRunning: handle.isRunning.pipe(Effect.orElseSucceed(() => false)),
    kill: (signal) =>
      handle.kill({ killSignal: signal }).pipe(Effect.ignore, Effect.asVoid),
  };
}

function waitForProcesses(
  processes: readonly ProviderTrackedProcess[],
  timeout: Duration.Input,
): Effect.Effect<boolean> {
  const wait = Effect.gen(function* () {
    while (true) {
      const running = yield* Effect.forEach(processes, (process) => process.isRunning);
      if (running.every((value) => !value)) return;
      yield* Effect.sleep("50 millis");
    }
  });
  return wait.pipe(Effect.timeoutOption(timeout), Effect.map(Option.isSome));
}

/**
 * Runs the provider's cooperative shutdown first, then escalates the complete
 * child-process group through SIGTERM and SIGKILL. Every phase is bounded so a
 * wedged harness cannot block orchestration indefinitely.
 */
export function terminateProviderProcesses<E>(input: {
  readonly processes: readonly ProviderTrackedProcess[];
  readonly cooperative: Effect.Effect<void, E>;
}): Effect.Effect<ProviderSessionStopResult> {
  const processes = input.processes.slice(0, 32);
  const pids = processes.map((process) => process.pid);
  return Effect.gen(function* () {
    if (processes.length === 0) {
      const completed = yield* input.cooperative.pipe(
        Effect.ignore,
        Effect.as(true),
        Effect.timeoutOrElse({ duration: "14 seconds", orElse: () => Effect.succeed(false) }),
      );
      return completed ? NO_PROCESS_STOP_RESULT : { ...NO_PROCESS_STOP_RESULT, terminated: false };
    }

    const cooperativeFiber = yield* input.cooperative.pipe(
      Effect.ignore,
      Effect.forkChild({ startImmediately: true }),
    );
    if (yield* waitForProcesses(processes, "5 seconds")) {
      yield* Fiber.interrupt(cooperativeFiber).pipe(Effect.ignore);
      return { terminated: true, method: "cooperative", pids };
    }

    yield* Effect.forEach(
      processes,
      (process) => process.kill("SIGTERM").pipe(Effect.forkChild({ startImmediately: true })).pipe(Effect.asVoid),
      { discard: true },
    );
    if (yield* waitForProcesses(processes, "5 seconds")) {
      yield* Fiber.interrupt(cooperativeFiber).pipe(Effect.ignore);
      return { terminated: true, method: "sigterm", pids };
    }

    yield* Effect.forEach(
      processes,
      (process) => process.kill("SIGKILL").pipe(Effect.forkChild({ startImmediately: true })).pipe(Effect.asVoid),
      { discard: true },
    );
    const terminated = yield* waitForProcesses(processes, "4 seconds");
    yield* Fiber.interrupt(cooperativeFiber).pipe(Effect.ignore);
    return { terminated, method: "sigkill", pids };
  });
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderSessionStopResult | void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
