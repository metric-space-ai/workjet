export type ShellPackLifecycleState =
  | { readonly status: "idle" }
  | { readonly status: "consent"; readonly totalBytes: number }
  | { readonly status: "downloading"; readonly totalBytes: number; readonly receivedBytes: number }
  | { readonly status: "ready"; readonly packId: string; readonly rootUri: string }
  | {
      readonly status: "error";
      readonly reason: "cancelled" | "offline" | "integrity" | "unavailable";
    };

export type ShellPackLifecycleEvent =
  | { readonly type: "request"; readonly totalBytes: number }
  | { readonly type: "approve" }
  | { readonly type: "progress"; readonly receivedBytes: number }
  | { readonly type: "complete"; readonly packId: string; readonly rootUri: string }
  | { readonly type: "cancel" }
  | { readonly type: "fail"; readonly reason: "offline" | "integrity" | "unavailable" }
  | { readonly type: "retry" };

export function transitionShellPackLifecycle(
  state: ShellPackLifecycleState,
  event: ShellPackLifecycleEvent,
): ShellPackLifecycleState {
  if (event.type === "request" && (state.status === "idle" || state.status === "error")) {
    return { status: "consent", totalBytes: event.totalBytes };
  }
  if (event.type === "approve" && state.status === "consent") {
    return { status: "downloading", totalBytes: state.totalBytes, receivedBytes: 0 };
  }
  if (event.type === "progress" && state.status === "downloading") {
    return {
      ...state,
      receivedBytes: Math.max(state.receivedBytes, Math.min(state.totalBytes, event.receivedBytes)),
    };
  }
  if (event.type === "complete" && state.status === "downloading") {
    return { status: "ready", packId: event.packId, rootUri: event.rootUri };
  }
  if (event.type === "cancel" && (state.status === "consent" || state.status === "downloading")) {
    return { status: "error", reason: "cancelled" };
  }
  if (event.type === "fail" && state.status !== "ready") {
    return { status: "error", reason: event.reason };
  }
  if (event.type === "retry" && state.status === "error") return { status: "idle" };
  return state;
}
