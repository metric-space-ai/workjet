// @effect-diagnostics globalTimers:off -- Process termination deadlines must use wall time even when adapter tests provide Effect TestClock.
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
import * as Fiber from "effect/Fiber";
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

function wallSleep(milliseconds: number): Effect.Effect<void> {
  return Effect.promise(
    () => new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds)),
  );
}

function waitForProcesses(
  processes: readonly ProviderTrackedProcess[],
  timeoutMs: number,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const expiresAt = performance.now() + timeoutMs;
    while (true) {
      const running = yield* Effect.forEach(processes, (process) => process.isRunning);
      if (running.every((value) => !value)) return true;
      if (performance.now() >= expiresAt) return false;
      yield* wallSleep(Math.min(50, Math.max(1, expiresAt - performance.now())));
    }
  });
}

function waitForFiber(fiber: Fiber.Fiber<void>, timeoutMs: number): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const expiresAt = performance.now() + timeoutMs;
    while (true) {
      if (fiber.pollUnsafe() !== undefined) return true;
      if (performance.now() >= expiresAt) return false;
      yield* wallSleep(Math.min(50, Math.max(1, expiresAt - performance.now())));
    }
  });
}

/**
 * Runs the provider's cooperative shutdown first, then escalates the complete
 * child-process group through SIGTERM and SIGKILL. Every phase is bounded so a
 * wedged harness cannot block orchestration indefinitely.
 */
export function terminateProviderProcesses<E>(input: {
  readonly processes: readonly ProviderTrackedProcess[];
  readonly cooperative: Effect.Effect<void, E>;
  /** Test-only override; production always uses the five-second default. */
  readonly phaseTimeoutMs?: number;
}): Effect.Effect<ProviderSessionStopResult> {
  const processes = input.processes.slice(0, 32);
  const pids = processes.map((process) => process.pid);
  const phaseTimeoutMs = input.phaseTimeoutMs ?? 5_000;
  return Effect.gen(function* () {
    const cooperativeFiber = yield* input.cooperative.pipe(
      Effect.ignore,
      Effect.forkDetach({ startImmediately: true }),
    );
    if (processes.length === 0) {
      const completed = yield* waitForFiber(
        cooperativeFiber,
        phaseTimeoutMs === 5_000 ? 14_000 : phaseTimeoutMs * 3,
      );
      return completed ? NO_PROCESS_STOP_RESULT : { ...NO_PROCESS_STOP_RESULT, terminated: false };
    }

    if (yield* waitForProcesses(processes, phaseTimeoutMs)) {
      cooperativeFiber.interruptUnsafe();
      return { terminated: true, method: "cooperative", pids };
    }

    yield* Effect.forEach(
      processes,
      (process) => process.kill("SIGTERM").pipe(Effect.forkDetach({ startImmediately: true })).pipe(Effect.asVoid),
      { discard: true },
    );
    if (yield* waitForProcesses(processes, phaseTimeoutMs)) {
      cooperativeFiber.interruptUnsafe();
      return { terminated: true, method: "sigterm", pids };
    }

    yield* Effect.forEach(
      processes,
      (process) => process.kill("SIGKILL").pipe(Effect.forkDetach({ startImmediately: true })).pipe(Effect.asVoid),
      { discard: true },
    );
    const terminated = yield* waitForProcesses(
      processes,
      phaseTimeoutMs === 5_000 ? 4_000 : phaseTimeoutMs,
    );
    cooperativeFiber.interruptUnsafe();
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
