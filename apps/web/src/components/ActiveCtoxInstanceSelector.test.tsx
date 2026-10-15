import type { CtoxManagedInstance } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";

import selectorSource from "./ActiveCtoxInstanceSelector.tsx?raw";

import {
  INSTANCE_PICKER_SEARCH_THRESHOLD,
  resolveActiveCtoxInstanceId,
  selectableCtoxInstances,
  filterCtoxInstances,
  ctoxInstancePickerStatus,
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
  it("rejects a stale id without silently selecting the first discovered instance", () => {
    const alpha = instance("instance-alpha", "Alpha");
    const beta = instance("instance-beta", "Beta");
    const sshInstance = instance("ssh:gpu-1", "gpu1", "ssh_managed");
    const instances = selectableCtoxInstances({
      _tag: "ready",
      managedState: "ready",
      instances: [beta, sshInstance, alpha],
    });

    expect(instances.map((entry) => entry.id)).toEqual([
      "instance-alpha",
      "instance-beta",
      "ssh:gpu-1",
    ]);
    expect(resolveActiveCtoxInstanceId(instances, "stale-instance")).toBeNull();
    expect(resolveActiveCtoxInstanceId(instances, "instance-beta")).toBe("instance-beta");
  });
});

describe("instance picker identity and discovery", () => {
  it("deduplicates ids without conflating equally named instances", () => {
    const first = instance("one", "Welsch");
    const second = instance("two", "Welsch");
    const result = selectableCtoxInstances({ _tag: "ready", instances: [first, first, second] });
    expect(result.map((entry) => entry.id)).toEqual(["one", "two"]);
  });
  it("finds a host and local computer without changing the selected id", () => {
    const remote = { ...instance("one", "Welsch"), domain: "welsch.ctox.dev" };
    const local = instance("two", "Office", "local_daemon");
    expect(filterCtoxInstances([remote, local], "  CTOX.DEV ")).toEqual([remote]);
    expect(filterCtoxInstances([remote, local], "lokal")).toEqual([local]);
    expect(filterCtoxInstances([remote, local], "local")).toEqual([local]);
    expect(filterCtoxInstances([remote, local], "unknown")).toEqual([]);
    expect(resolveActiveCtoxInstanceId([remote, local], "two")).toBe("two");
  });
  it("does not call a discoverable instance connected before the data plane is ready", () => {
    const ready = instance("one", "Ready");
    expect(ctoxInstancePickerStatus(ready)).toBe("verbunden");
    expect(
      ctoxInstancePickerStatus({
        ...ready,
        healthSummary: { ...healthSummary, dataPlaneReady: false },
      }),
    ).toBe("verbindet");
    expect(ctoxInstancePickerStatus({ ...ready, status: "pairing_expired" })).toBe(
      "Kopplung abgelaufen",
    );
  });
});

describe("instance dropdown", () => {
  it("shows one row per instance: duplicates by domain collapse, removed entries disappear", () => {
    const managed = { ...instance("managed:welsch", "Welsch"), domain: "welsch.ctox.dev" };
    const paired = {
      ...instance("paired:welsch", "Welsch", "pairing_invite"),
      domain: "welsch.ctox.dev",
    };
    const removed = { ...instance("gone", "Alt"), workjetState: "removed" as const };
    const result = selectableCtoxInstances(
      { _tag: "ready", instances: [paired, managed, removed] },
      "paired:welsch",
    );
    expect(result.map((entry) => entry.id)).toEqual(["paired:welsch"]);
  });

  it("only offers a search field above twelve instances", () => {
    expect(INSTANCE_PICKER_SEARCH_THRESHOLD).toBe(12);
  });

  it("has no network-overview entry and no popover with content", () => {
    expect(selectorSource).not.toContain("Network overview");
    expect(selectorSource).not.toContain("showNetwork");
    expect(selectorSource).not.toContain("PopoverPopup");
    expect(selectorSource).toContain("Instanz hinzufügen");
    expect(selectorSource).toContain("Instanzen verwalten");
  });
});
