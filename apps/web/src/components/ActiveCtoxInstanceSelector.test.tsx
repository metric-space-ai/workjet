import type { CtoxManagedInstance } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createCrossModeSelectionMemory } from "../crossMode/crossModeSelectionMemory";
import {
  resolveActiveCtoxInstanceId,
  selectActiveCtoxInstance,
  selectableCtoxInstances,
} from "./ActiveCtoxInstanceSelector";

const healthSummary = {
  dataPlane: "rxdb-webrtc" as const,
  dataPlaneReady: true,
  httpDataProxy: false as const,
  nativePeerObserved: true,
};

function instance(
  id: string,
  displayName: string,
  source: CtoxManagedInstance["source"] = "ctox_dev",
): CtoxManagedInstance {
  return { id, displayName, source, status: "available", healthSummary };
}

describe("ActiveCtoxInstanceSelector", () => {
  it("falls back from a stale id to the first real discovered instance", () => {
    const alpha = instance("instance-alpha", "Alpha");
    const beta = instance("instance-beta", "Beta");
    const sshComputer = instance("ssh:gpu-1", "gpu1", "ssh_managed");
    const instances = selectableCtoxInstances({
      _tag: "ready",
      managedState: "ready",
      instances: [beta, sshComputer, alpha],
    });

    expect(instances.map((entry) => entry.id)).toEqual(["instance-alpha", "instance-beta"]);
    expect(resolveActiveCtoxInstanceId(instances, "stale-instance")).toBe("instance-alpha");
    expect(resolveActiveCtoxInstanceId(instances, "instance-beta")).toBe("instance-beta");
  });

  it("publishes Code-mode selection without mounting or requesting Business OS", () => {
    const memory = createCrossModeSelectionMemory();
    const scopeChanges: string[] = [];
    const guestRequests: unknown[] = [];
    memory.subscribeToActiveCtoxInstance(() => {
      const instanceId = memory.readActiveCtoxInstanceId();
      if (instanceId !== null) scopeChanges.push(instanceId);
    });

    expect(
      selectActiveCtoxInstance({
        instances: [{ id: "instance-beta" }],
        instanceId: "instance-beta",
        productMode: "code",
        memory,
        requestBusinessOsInstance: (target) => guestRequests.push(target),
      }),
    ).toBe(true);

    expect(scopeChanges).toEqual(["instance-beta"]);
    expect(guestRequests).toEqual([]);
  });

  it("uses the existing handoff when selection changes in Business OS", () => {
    const memory = createCrossModeSelectionMemory();
    const guestRequests: unknown[] = [];

    selectActiveCtoxInstance({
      instances: [{ id: "instance-alpha" }],
      instanceId: "instance-alpha",
      productMode: "ctox",
      memory,
      requestBusinessOsInstance: (target) => guestRequests.push(target),
    });

    expect(guestRequests).toEqual([{ mode: "business-os", ctoxInstanceId: "instance-alpha" }]);
  });
});
