import {
  getBoundCtoxClientInstance,
  getCtoxClient,
  subscribeCtoxClients,
  type CommandHandle,
  type CommandState,
  type CtoxAppApi,
} from "./ctoxClient";

export class CtoxCommandError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CtoxCommandError";
  }
}

/** A write rejection carries the Core code (K-WJ-B2 `unknown_command`), never a free-text reason. */
function rejectionCode(state: CommandState): string | undefined {
  const typed = (state as { code?: unknown }).code;
  if (typeof typed === "string" && typed) return typed;
  const error = state.error;
  if (typeof error !== "string") return undefined;
  const match = /^([a-z][a-z0-9_]*):/.exec(error);
  return match ? match[1] : error;
}

/** Observe command execution, not merely the write ACK. Detaching never cancels durable work.
 * A done enqueue-command is not proof its agent task finished; that task owns its callbacks/projection.
 */
export function observeCtoxCommand(
  handle: CommandHandle,
  callbacks: {
    onComplete: (result: unknown) => void;
    onFailed: (code: string) => void;
  },
): () => void {
  let settled = false;
  let off: (() => void) | undefined;
  const receive = (state: CommandState) => {
    // The merged kernel can project these terminal states before its .d.ts catches up.
    const runtimeStatus: string = state.status;
    if (!settled && (runtimeStatus === "cancelled" || runtimeStatus === "rejected")) {
      settled = true;
      off?.();
      callbacks.onFailed(rejectionCode(state) ?? runtimeStatus);
      return;
    }
    if (settled || (state.status !== "done" && state.status !== "failed")) return;
    settled = true;
    off?.();
    if (state.status === "done") callbacks.onComplete(state.result);
    else callbacks.onFailed(rejectionCode(state) ?? "command_failed");
  };
  off = handle.status.subscribe(receive);
  if (settled) off();
  return () => {
    settled = true;
    off?.();
  };
}

/** Core handler callbacks (§16.30/39) stay in the handler; these only consume its projection. */
export function executeCtoxCommand(
  api: CtoxAppApi,
  type: string,
  payload: object,
  options?: { record_id?: string; signal?: AbortSignal },
): Promise<unknown> {
  if (options?.signal?.aborted) return Promise.reject(new CtoxCommandError("aborted"));
  const instanceId = getBoundCtoxClientInstance(api);
  if (instanceId === null) return Promise.reject(new CtoxCommandError("ctox_client_unavailable"));
  const handle = api.command(
    type,
    payload,
    options?.record_id === undefined
      ? undefined
      : {
          record_id: options.record_id,
        },
  );
  return new Promise((resolve, reject) => {
    let off = () => {};
    let offScope = () => {};
    const cleanup = () => {
      off();
      offScope();
      options?.signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new CtoxCommandError("aborted"));
    };
    options?.signal?.addEventListener("abort", abort, { once: true });
    offScope = subscribeCtoxClients(() => {
      if (getCtoxClient(instanceId) === api) return;
      cleanup();
      reject(new CtoxCommandError("ctox_scope_changed"));
    });
    off = observeCtoxCommand(handle, {
      onComplete: (result) => {
        cleanup();
        resolve(result);
      },
      onFailed: (code) => {
        cleanup();
        reject(new CtoxCommandError(code));
      },
    });
    void handle.local.catch((error: unknown) => {
      cleanup();
      reject(error);
    });
    if (options?.signal?.aborted) abort();
  });
}
