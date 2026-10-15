import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  closeInstanceSetup,
  instanceAddRequestFromSearch,
  instanceSetupStore,
  isInstancesPageRequest,
  openInstanceRePair,
  openInstanceSetup,
  registerInstanceSetupNavigator,
  type InstanceSetupPath,
} from "./instanceSetup";

afterEach(closeInstanceSetup);
describe("instance pairing recovery action", () => {
  for (const source of ["manual_pairing", "pairing_invite"] as const)
    it("replaces the same saved identity for " + source, () => {
      openInstanceRePair({ id: "paired:fixture", source });
      expect(instanceSetupStore.getSnapshot()).toMatchObject({
        intent: "link",
        option: "link",
        replacesInstanceId: "paired:fixture",
      });
    });
  it("uses managed setup without replacing accountless pairing", () => {
    openInstanceRePair({ id: "managed:fixture", source: "ctox_dev" });
    expect(instanceSetupStore.getSnapshot()?.intent).toBe("managed");
    expect(instanceSetupStore.getSnapshot()?.option).toBe("ctox-dev");
    expect(instanceSetupStore.getSnapshot()?.replacesInstanceId).toBeUndefined();
  });
});

describe("instance setup opens inline on Einstellungen › Instanzen", () => {
  it("navigates every caller to the Instanzen page with the requested option", () => {
    const visited: InstanceSetupPath[] = [];
    const unregister = registerInstanceSetupNavigator((path) => visited.push(path));
    try {
      for (const [intent, option] of [
        ["choose", "ctox-dev"],
        ["create", "ctox-dev"],
        ["managed", "ctox-dev"],
        ["connect", "link"],
        ["link", "link"],
        ["qr", "qr"],
        ["manual", "manual"],
      ] as const) {
        openInstanceSetup(intent);
        const request = instanceSetupStore.getSnapshot();
        expect(request?.option).toBe(option);
        expect(isInstancesPageRequest(request)).toBe(true);
      }
      expect(new Set(visited)).toEqual(new Set(["/settings/business-os"]));
    } finally {
      unregister();
    }
  });

  it("sends new computers to Einstellungen › Rechner without opening the instance panel", () => {
    const visited: InstanceSetupPath[] = [];
    const unregister = registerInstanceSetupNavigator((path) => visited.push(path));
    try {
      for (const intent of ["local", "ssh", "tailscale"] as const) {
        openInstanceSetup(intent);
        expect(instanceSetupStore.getSnapshot()?.intent).toBe(intent);
        expect(isInstancesPageRequest(instanceSetupStore.getSnapshot())).toBe(false);
      }
      expect(visited).toEqual([
        "/settings/computers",
        "/settings/computers",
        "/settings/computers",
      ]);
    } finally {
      unregister();
    }
  });

  it("uses the most recently registered navigator and falls back after unregistering", () => {
    const calls: string[] = [];
    const outer = registerInstanceSetupNavigator(() => calls.push("header"));
    const inner = registerInstanceSetupNavigator(() => calls.push("page"));
    openInstanceSetup();
    inner();
    openInstanceSetup();
    outer();
    expect(calls).toEqual(["page", "header"]);
  });
});

describe("pair deep link search parameters", () => {
  it("prefills the invitation link from a workjet://pair payload", () => {
    expect(instanceAddRequestFromSearch({ add: "link", payload: "WyJ3MiJd" })).toEqual({
      option: "link",
      invite: "workjet://pair?payload=WyJ3MiJd",
    });
  });
  it("opens a plain option and ignores anything malformed", () => {
    expect(instanceAddRequestFromSearch({ add: "manual" })).toEqual({ option: "manual" });
    expect(instanceAddRequestFromSearch({ add: "dialog" })).toBeNull();
    expect(instanceAddRequestFromSearch({ add: "link", payload: "a b" })).toEqual({
      option: "link",
    });
    expect(instanceAddRequestFromSearch({ payload: 42 })).toBeNull();
    expect(instanceAddRequestFromSearch({})).toBeNull();
    expect(instanceAddRequestFromSearch(undefined)).toBeNull();
  });
});
