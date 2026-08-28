import { describe, expect, it } from "vite-plus/test";

import { transitionShellPackLifecycle, type ShellPackLifecycleState } from "./shell-pack-lifecycle";

describe("Business OS shell pack lifecycle", () => {
  it("requires consent and tracks bounded progress before activation", () => {
    let state: ShellPackLifecycleState = { status: "idle" };
    state = transitionShellPackLifecycle(state, { type: "request", totalBytes: 100 });
    expect(state.status).toBe("consent");
    state = transitionShellPackLifecycle(state, { type: "approve" });
    state = transitionShellPackLifecycle(state, { type: "progress", receivedBytes: 120 });
    expect(state).toEqual({ status: "downloading", totalBytes: 100, receivedBytes: 100 });
    state = transitionShellPackLifecycle(state, {
      type: "complete",
      packId: "pack-a",
      rootUri: "file:///pack",
    });
    expect(state.status).toBe("ready");
  });

  it.each(["cancelled", "offline", "integrity"] as const)(
    "keeps a %s failure retryable without affecting other modules",
    (reason) => {
      let state: ShellPackLifecycleState = { status: "idle" };
      if (reason === "cancelled") {
        state = transitionShellPackLifecycle(state, { type: "request", totalBytes: 100 });
        state = transitionShellPackLifecycle(state, { type: "cancel" });
      } else {
        state = transitionShellPackLifecycle(state, { type: "fail", reason });
      }
      expect(state).toEqual({ status: "error", reason });
      expect(transitionShellPackLifecycle(state, { type: "retry" })).toEqual({ status: "idle" });
    },
  );
});
