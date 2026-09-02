import type {
  CtoxWorkjetSessionTransferEvent,
  EnvironmentId,
  OrchestrationLatestTurn,
  OrchestrationSession,
  ScopedThreadRef,
  ThreadId,
  WorkjetThreadConfig,
} from "@t3tools/contracts";

export interface WorkjetPauseThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly workjetConfig: WorkjetThreadConfig;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly session: OrchestrationSession | null;
}

export type WorkjetSessionPausePlan =
  | { readonly kind: "ignore" }
  | { readonly kind: "interrupt"; readonly threadRef: ScopedThreadRef }
  | {
      readonly kind: "ack";
      readonly threadRef: ScopedThreadRef;
      readonly lastTerminalTurnId: string | null;
    };

export type WorkjetPauseHardCancelResult = "confirmed" | "unconfirmed" | "cancelled";

function lastTerminalTurnId(thread: WorkjetPauseThread): string | null {
  return thread.latestTurn !== null && thread.latestTurn.state !== "running"
    ? thread.latestTurn.turnId
    : null;
}

/**
 * Dispatches the existing session-stop command at most once for a transfer and
 * waits for the stopped session projection before acknowledging the pause.
 */
export async function runPauseHardCancel(input: {
  readonly transferId: string;
  readonly threadRef: ScopedThreadRef;
  readonly requestedTransferIds: Set<string>;
  readonly requestStop: () => void | Promise<unknown>;
  readonly readThread: () => WorkjetPauseThread | undefined;
  readonly acknowledge: (lastTerminalTurnId: string | null) => void | Promise<void>;
  readonly onUnconfirmed: () => void;
  readonly isCancelled?: () => boolean;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<WorkjetPauseHardCancelResult> {
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds)));
  const expiresAt = now() + input.timeoutMs;

  if (!input.requestedTransferIds.has(input.transferId)) {
    input.requestedTransferIds.add(input.transferId);
    try {
      const pending = input.requestStop();
      if (pending !== undefined) void Promise.resolve(pending).catch(() => undefined);
    } catch {
      // Confirmation still comes exclusively from the projected session state.
    }
  }

  while (!(input.isCancelled?.() ?? false)) {
    const thread = input.readThread();
    if (
      thread !== undefined &&
      thread.environmentId === input.threadRef.environmentId &&
      thread.id === input.threadRef.threadId &&
      thread.session?.status === "stopped"
    ) {
      await input.acknowledge(lastTerminalTurnId(thread));
      return "confirmed";
    }

    const remainingMs = expiresAt - now();
    if (remainingMs <= 0) {
      input.onUnconfirmed();
      return "unconfirmed";
    }
    await sleep(Math.min(input.pollMs, remainingMs));
  }

  return "cancelled";
}

function configuredSessionId(thread: WorkjetPauseThread): string | null {
  const config = thread.workjetConfig;
  if (!("ctoxSession" in config)) return null;
  return config.ctoxSession?.sessionId ?? null;
}

function threadRef(thread: WorkjetPauseThread): ScopedThreadRef {
  return { environmentId: thread.environmentId, threadId: thread.id };
}

export function planPauseReaction(input: {
  readonly event: CtoxWorkjetSessionTransferEvent;
  readonly threads: readonly WorkjetPauseThread[];
  readonly localComputerId: string | null;
  readonly acknowledged: ReadonlySet<string>;
}): WorkjetSessionPausePlan {
  const { event } = input;
  if (
    input.localComputerId === null ||
    event.state !== "pause_requested" ||
    event.sourceComputerId !== input.localComputerId ||
    input.acknowledged.has(event.transferId)
  ) {
    return { kind: "ignore" };
  }

  const thread = input.threads.find(
    (candidate) => configuredSessionId(candidate) === event.sessionId,
  );
  if (thread === undefined) return { kind: "ignore" };

  if (thread.session?.status === "stopped") {
    return {
      kind: "ack",
      threadRef: threadRef(thread),
      lastTerminalTurnId: lastTerminalTurnId(thread),
    };
  }

  if (thread.session?.status === "running" || thread.latestTurn?.state === "running") {
    return { kind: "interrupt", threadRef: threadRef(thread) };
  }

  return {
    kind: "ack",
    threadRef: threadRef(thread),
    lastTerminalTurnId: lastTerminalTurnId(thread),
  };
}
