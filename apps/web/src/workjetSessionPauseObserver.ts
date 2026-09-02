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

  if (thread.session?.status === "running" || thread.latestTurn?.state === "running") {
    return { kind: "interrupt", threadRef: threadRef(thread) };
  }

  const lastTerminalTurnId = thread.latestTurn?.turnId ?? null;
  return { kind: "ack", threadRef: threadRef(thread), lastTerminalTurnId };
}
