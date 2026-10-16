import {
  EnvironmentId,
  WorkjetComputerId,
  type CtoxWorkjetComputerControlResult,
  type CtoxWorkjetComputerProjection,
  type DesktopCtoxBridge,
  type WorkjetComputer,
} from "@workjet/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  MEMBERSHIP_DEADLINE_MS,
  MEMBERSHIP_FAILURE_GRACE_MS,
  MEMBERSHIP_SILENT_RETRY_MS,
  createComputerMembershipStore,
} from "./workjetComputerMembership";
import type { OperationalComputerEnrollment } from "./computerCapabilityEnrollment";

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
  const nas: OperationalComputerEnrollment = {
    computerId: "nas-native",
    displayName: "NAS",
    hostingMode: "self_hosted",
    agentless: true,
    agentCapabilities: [],
    capabilityConfig: [
      {
        kind: "storage",
        endpoint_ref: "nas-access",
        protocol: "ssh",
        root: "/volume1/artifacts",
        quota_gib: null,
        purposes: ["artifacts"],
      },
    ],
    endpoint: {
      ref: "nas-access",
      connection: {
        protocol: "ssh",
        host: "nas.example.test",
        port: 22,
        username: "admin",
        root: "/volume1/artifacts",
        host_key_sha256: "SHA256:pin",
        private_key: { scope: "access", name: "nas" },
        passphrase: null,
      },
    },
  };
  const nasProjection = {
    ...projection,
    id: nas.computerId,
    displayName: "NAS",
    hostingMode: "self_hosted" as const,
    capabilities: ["storage"],
  };

  it("removes a native-only NAS without creating a coding connection", async () => {
    const store = createComputerMembershipStore();
    const request = port().mockResolvedValueOnce(listed([nasProjection]));
    await store.refresh("selected", bridge(request));
    request.mockResolvedValueOnce({
      _tag: "completed",
      response: {
        action: "computer.unassign",
        computer: { ...nasProjection, status: "unassigned" },
      },
    });
    expect(await store.unassign("selected", nas.computerId, bridge(request))).toBe(true);
    expect(store.getSnapshot().computers).toEqual([]);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      action: "computer.unassign",
      computerId: nas.computerId,
    });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("environmentId");
  });

  it("serializes enrollment and publishes only after both native confirmations", async () => {
    const store = createComputerMembershipStore();
    const request = port().mockResolvedValueOnce(listed());
    await store.refresh("selected", bridge(request));
    const pending = deferredResult();
    request
      .mockResolvedValueOnce({
        _tag: "completed",
        response: {
          action: "computer.assign",
          computer: nasProjection,
        },
      })
      .mockReturnValueOnce(pending.promise);
    const enrollment = store.enroll("selected", nas, bridge(request));
    await Promise.resolve();
    expect(store.getSnapshot().pendingComputerId).toBe(nas.computerId);
    expect(store.getSnapshot().computers).toEqual([]);
    await expect(store.enroll("selected", nas, bridge(request))).rejects.toThrow(
      "prüft ihre Rechner",
    );
    pending.resolve({
      _tag: "completed",
      response: {
        action: "computer.endpoint.upsert",
        computerId: nas.computerId,
        endpointRef: "nas-access",
        enabled: true,
      },
    });
    await enrollment;
    expect(store.getSnapshot().computers).toEqual([nasProjection]);
    expect(store.getSnapshot().pendingComputerId).toBeNull();
  });

  it("does not publish old enrollment or configure its endpoint after switching instances", async () => {
    const store = createComputerMembershipStore();
    const request = port().mockResolvedValueOnce(listed());
    await store.refresh("selected", bridge(request));
    const pending = deferredResult();
    request.mockReturnValueOnce(pending.promise);
    const enrollment = store.enroll("selected", nas, bridge(request));
    store.select("other");
    pending.resolve({
      _tag: "completed",
      response: {
        action: "computer.assign",
        computer: nasProjection,
      },
    });
    await expect(enrollment).rejects.toThrow("Instanz gewechselt");
    expect(request).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({ instanceId: "other", computers: [] });
  });
  it.each([
    ["sync_unavailable", "Synchronisierung"],
    ["query_unsupported", "Rechnerliste noch nicht laden"],
    ["command_failed", "nicht ausführen"],
    ["response_invalid", "unpassendes Ergebnis"],
  ] as const)(
    "explains %s without granting membership and permits a successful retry",
    async (code, message) => {
      const store = createComputerMembershipStore();
      const request = port()
        .mockResolvedValueOnce({ _tag: "failed", code })
        .mockResolvedValueOnce(listed([projection]));
      await store.refresh("managed:welsch", bridge(request));
      expect(store.getSnapshot().error).toContain(message);
      expect(store.getSnapshot().computers).toEqual([]);
      await store.refresh("managed:welsch", bridge(request));
      expect(store.getSnapshot().phase).toBe("ready");
      expect(store.getSnapshot().error).toBeNull();
      expect(store.getSnapshot().computers).toEqual([projection]);
    },
  );

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
    expect(store.getSnapshot().error).toContain("anmelden");
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
    expect(store.getSnapshot().error).toContain("nicht bestätigt werden");
    expect(store.getSnapshot().pendingComputerId).toBeNull();
  });

  it("stops checking a blocked instance after the deadline and allows a retry", async () => {
    vi.useFakeTimers();
    try {
      const store = createComputerMembershipStore();
      const request = port()
        .mockReturnValueOnce(new Promise(() => undefined))
        .mockResolvedValueOnce(listed([projection]));
      const refresh = store.refresh("managed:welsch", bridge(request));
      expect(store.getSnapshot().phase).toBe("loading");
      await vi.advanceTimersByTimeAsync(MEMBERSHIP_DEADLINE_MS);
      await refresh;
      expect(store.getSnapshot()).toMatchObject({ phase: "failed", computers: [] });
      expect(store.getSnapshot().error).toBe("Instanz antwortet nicht.");
      await store.refresh("managed:welsch", bridge(request));
      expect(store.getSnapshot()).toMatchObject({ phase: "ready", computers: [projection] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports unsupported shells and never invents a local grant", async () => {
    const store = createComputerMembershipStore();
    await store.refresh("managed:welsch", undefined);
    expect(store.getSnapshot()).toMatchObject({ phase: "failed", computers: [] });
    expect(store.getSnapshot().error).toContain("braucht ein Update");
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
    expect(store.getSnapshot().error).toContain("noch nicht bestätigt");
  });
});

describe("silent membership retries (N7)", () => {
  it("shows the failure line only after two minutes of transient failures, then retries silently", async () => {
    vi.useFakeTimers();
    try {
      const store = createComputerMembershipStore();
      const request = port()
        .mockResolvedValueOnce({ _tag: "failed", code: "timeout" })
        .mockResolvedValueOnce({ _tag: "failed", code: "timeout" })
        .mockResolvedValueOnce(listed([projection]));
      const started = Date.now();
      await store.refresh("managed:welsch", bridge(request));
      const first = store.getSnapshot();
      expect(first.phase).toBe("failed");
      expect(first.failureVisibleAtMs).toBe(started + MEMBERSHIP_FAILURE_GRACE_MS);
      await vi.advanceTimersByTimeAsync(MEMBERSHIP_SILENT_RETRY_MS);
      // The second failure keeps the first deadline instead of pushing it back.
      expect(store.getSnapshot().failureVisibleAtMs).toBe(first.failureVisibleAtMs);
      await vi.advanceTimersByTimeAsync(MEMBERSHIP_SILENT_RETRY_MS);
      expect(store.getSnapshot()).toMatchObject({
        phase: "ready",
        computers: [projection],
        failureVisibleAtMs: null,
      });
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows failures that need the user at once and does not loop on them", async () => {
    vi.useFakeTimers();
    try {
      const store = createComputerMembershipStore();
      const request = port().mockResolvedValue({ _tag: "failed", code: "authentication_required" });
      await store.refresh("managed:welsch", bridge(request));
      expect(store.getSnapshot().failureVisibleAtMs).toBeLessThanOrEqual(Date.now());
      await vi.advanceTimersByTimeAsync(MEMBERSHIP_SILENT_RETRY_MS * 3);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
