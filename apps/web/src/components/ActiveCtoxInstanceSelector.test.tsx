import type { CtoxManagedInstance } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveActiveCtoxInstanceId, selectableCtoxInstances } from "./ActiveCtoxInstanceSelector";

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
  it("rejects a stale id without silently selecting the first discovered instance", () => {
    const alpha = instance("instance-alpha", "Alpha");
    const beta = instance("instance-beta", "Beta");
    const sshComputer = instance("ssh:gpu-1", "gpu1", "ssh_managed");
    const instances = selectableCtoxInstances({
      _tag: "ready",
      managedState: "ready",
      instances: [beta, sshComputer, alpha],
    });

    expect(instances.map((entry) => entry.id)).toEqual(["instance-alpha", "instance-beta"]);
    expect(resolveActiveCtoxInstanceId(instances, "stale-instance")).toBeNull();
    expect(resolveActiveCtoxInstanceId(instances, "instance-beta")).toBe("instance-beta");
  });
});
