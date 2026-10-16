import { afterEach, describe, expect, it } from "vite-plus/test";
import type { CtoxManagedInstance } from "@workjet/contracts";
import {
  clearCtoxV4Instances,
  isCtoxV4Instance,
  setCtoxInstanceGeneration,
} from "./CtoxV4Instances.ts";
import { isLaunchableCtoxSshManagedInstance } from "./CtoxSshManagedSource.ts";

afterEach(clearCtoxV4Instances);

const sshInstance = (id: string) =>
  ({
    id,
    source: "ssh_managed",
    status: "available",
    healthSummary: {
      dataPlane: "rxdb-webrtc",
      httpDataProxy: false,
      dataPlaneReady: false,
      nativePeerObserved: false,
    },
  }) as unknown as CtoxManagedInstance;

describe("CtoxV4Instances (E49.6)", () => {
  it("tracks the reported generation; V3 and unknown stay V3", () => {
    expect(isCtoxV4Instance("ssh:a")).toBe(false);
    setCtoxInstanceGeneration("ssh:a", "v4");
    expect(isCtoxV4Instance("ssh:a")).toBe(true);
    setCtoxInstanceGeneration("ssh:a", "v3");
    expect(isCtoxV4Instance("ssh:a")).toBe(false);
    setCtoxInstanceGeneration("ssh:a", "v4");
    setCtoxInstanceGeneration("ssh:a", null);
    expect(isCtoxV4Instance("ssh:a")).toBe(false);
  });

  it("a V4 instance is never launchable over SSH; a V3 one still is", () => {
    const id = "ssh:AAAAAAAAAAAAAAAAAAAAAA";
    expect(isLaunchableCtoxSshManagedInstance(sshInstance(id))).toBe(true);
    setCtoxInstanceGeneration(id, "v4");
    expect(isLaunchableCtoxSshManagedInstance(sshInstance(id))).toBe(false);
  });
});
