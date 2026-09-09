import {
  EnvironmentId,
  WorkjetComputerId,
  type CtoxWorkjetComputerControlResult,
  type CtoxWorkjetComputerProjection,
  type DesktopCtoxBridge,
  type WorkjetComputer,
} from "@workjet/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { createComputerMembershipStore } from "./workjetComputerMembership";

function deferredResult() {
  let resolve!: (value: CtoxWorkjetComputerControlResult) => void;
  const promise = new Promise<CtoxWorkjetComputerControlResult>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const computer: WorkjetComputer = {
  id: WorkjetComputerId.make("computer-gpu"),
  label: "GPU",
  environmentId: EnvironmentId.make("ssh-gpu"),
  presentationKind: "tailscale",
  harnesses: [],
};
const projection: CtoxWorkjetComputerProjection = {
  id: computer.id,
  displayName: computer.label,
  hostingMode: "workstation",
  status: "assigned",
  capabilities: [],
  selfHostedColocation: false,
};
const listed = (
  computers: ReadonlyArray<CtoxWorkjetComputerProjection> = [],
): CtoxWorkjetComputerControlResult => ({
  _tag: "completed",
  response: { action: "computer.list", computers },
});
const port = () => vi.fn<NonNullable<DesktopCtoxBridge["requestComputerControl"]>>();
const bridge = (requestComputerControl: NonNullable<DesktopCtoxBridge["requestComputerControl"]>) =>
  ({ requestComputerControl }) as DesktopCtoxBridge;

describe("instance computer membership", () => {
  it("keeps confirmed computers during a same-instance refresh, but clears them on failure", async () => {
    const store = createComputerMembershipStore();
    const request = port().mockResolvedValueOnce(listed([projection]));
    await store.refresh("managed:welsch", bridge(request));
    const pending = deferredResult();
    request.mockReturnValueOnce(pending.promise);
    const refresh = store.refresh("managed:welsch", bridge(request));
    expect(store.getSnapshot().computers).toEqual([projection]);
    pending.resolve({ _tag: "failed", code: "authentication_required" });
    await refresh;
    expect(store.getSnapshot().computers).toEqual([]);
    expect(store.getSnapshot().error).toContain("Sign in");
  });
  it("waits for native confirmation, then adds and removes the exact computer", async () => {
    const store = createComputerMembershipStore();
    const request = port().mockResolvedValueOnce(listed());
    await store.refresh("managed:welsch", bridge(request));
    const pending = deferredResult();
    request.mockReturnValueOnce(pending.promise);
    const assignment = store.setAssigned("managed:welsch", computer, true, bridge(request));
    expect(store.getSnapshot().pendingComputerId).toBe(computer.id);
    expect(store.getSnapshot().computers).toEqual([]);
    pending.resolve({
      _tag: "completed",
      response: { action: "computer.assign", computer: projection },
    });
    expect(await assignment).toBe(true);
    expect(store.getSnapshot().computers).toEqual([projection]);
    const sent = request.mock.calls[1];
    expect(sent?.[0]).toBe("managed:welsch");
    expect(sent?.[1]).toMatchObject({
      action: "computer.assign",
      computerId: computer.id,
      selfHostedColocation: false,
    });
    expect(sent?.[1]).not.toHaveProperty("environmentId");
    request.mockResolvedValueOnce({
      _tag: "completed",
      response: { action: "computer.unassign", computer: { ...projection, status: "unassigned" } },
    });
    expect(await store.setAssigned("managed:welsch", computer, false, bridge(request))).toBe(true);
    expect(store.getSnapshot().computers).toEqual([]);
  });

  it("discards a late response after switching instances", async () => {
    const store = createComputerMembershipStore();
    const pending = deferredResult();
    const request = port().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(listed());
    const old = store.refresh("managed:welsch", bridge(request));
    await store.refresh("managed:other", bridge(request));
    pending.resolve(listed([projection]));
    await old;
    expect(store.getSnapshot()).toMatchObject({
      instanceId: "managed:other",
      computers: [],
      phase: "ready",
    });
  });

  it("does not apply an assignment to a newly selected instance", async () => {
    const store = createComputerMembershipStore();
    const request = port().mockResolvedValueOnce(listed());
    await store.refresh("managed:welsch", bridge(request));
    const pending = deferredResult();
    request.mockReturnValueOnce(pending.promise);
    const mutation = store.setAssigned("managed:welsch", computer, true, bridge(request));
    store.select("managed:other");
    pending.resolve({
      _tag: "completed",
      response: { action: "computer.assign", computer: projection },
    });
    expect(await mutation).toBe(false);
    expect(store.getSnapshot().computers).toEqual([]);
  });

  it("rejects a confirmation for a different computer and retains a retryable error", async () => {
    const store = createComputerMembershipStore();
    const request = port().mockResolvedValueOnce(listed());
    await store.refresh("managed:welsch", bridge(request));
    request.mockResolvedValueOnce({
      _tag: "completed",
      response: { action: "computer.assign", computer: { ...projection, id: "other-computer" } },
    });
    expect(await store.setAssigned("managed:welsch", computer, true, bridge(request))).toBe(false);
    expect(store.getSnapshot().computers).toEqual([]);
    expect(store.getSnapshot().error).toContain("Could not confirm");
    expect(store.getSnapshot().pendingComputerId).toBeNull();
  });

  it("reports unsupported shells and never invents a local grant", async () => {
    const store = createComputerMembershipStore();
    await store.refresh("managed:welsch", undefined);
    expect(store.getSnapshot()).toMatchObject({ phase: "failed", computers: [] });
    expect(store.getSnapshot().error).toContain("needs an update");
  });

  it("serializes visible mutations and excludes duplicate submits", async () => {
    const store = createComputerMembershipStore();
    const request = port().mockResolvedValueOnce(listed());
    await store.refresh("managed:welsch", bridge(request));
    const pending = deferredResult();
    request.mockReturnValueOnce(pending.promise);
    const first = store.setAssigned("managed:welsch", computer, true, bridge(request));
    expect(await store.setAssigned("managed:welsch", computer, true, bridge(request))).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
    pending.resolve({ _tag: "failed", code: "timeout" });
    expect(await first).toBe(false);
    expect(store.getSnapshot().error).toContain("not confirmed");
  });
});
