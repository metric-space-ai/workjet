import type { DesktopBridge, DesktopTailscalePeers } from "@workjet/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState, useEffect: reactHookHarness.useEffect };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
import { TailscalePeerSuggestions } from "./TailscalePeerSuggestions";

const result: DesktopTailscalePeers = {
  status: "available",
  peers: [
    { id: "one", name: "gpu1-A6000", hostname: "100.87.204.48", online: true },
    { id: "three", name: "gpu3-A4500", hostname: "100.71.114.101", online: false },
  ],
};
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("Tailscale peer suggestions", () => {
  beforeEach(() => hooks.reset());
  function render(
    bridge: Pick<DesktopBridge, "discoverTailscalePeers"> | undefined,
    onSelect = vi.fn(),
  ) {
    hooks.beginRender();
    return TailscalePeerSuggestions({ bridge, disabled: false, onSelect });
  }
  it("offers only online peers and never lists offline peers or SSH aliases", async () => {
    const bridge = { discoverTailscalePeers: vi.fn().mockResolvedValue(result) };
    const select = vi.fn();
    render(bridge, select);
    await settle();
    const tree = render(bridge, select);
    const action = visitElements(tree, (element) => element.props.children === "Use computer");
    expect(action).not.toBeNull();
    (action?.props.onClick as () => void)();
    expect(select).toHaveBeenCalledWith("100.87.204.48");
    expect(JSON.stringify(tree)).toContain("gpu1-A6000");
    expect(JSON.stringify(tree)).not.toContain("gpu3-A4500");
    expect(JSON.stringify(tree).match(/Use computer/gu)).toHaveLength(1);
    expect(JSON.stringify(tree)).not.toContain("known hosts");
  });
  it("shows unavailable without exposing rejected CLI text", async () => {
    const bridge = { discoverTailscalePeers: vi.fn().mockRejectedValue(new Error("tskey-secret")) };
    render(bridge);
    await settle();
    const text = JSON.stringify(render(bridge));
    expect(text).toContain("Tailscale discovery is unavailable");
    expect(text).not.toContain("tskey-secret");
    expect(text).not.toContain("Use computer");
  });
  it("ignores a stale response after the bridge changes", async () => {
    let complete!: (value: DesktopTailscalePeers) => void;
    const bridge = {
      discoverTailscalePeers: () =>
        new Promise<DesktopTailscalePeers>((resolve) => {
          complete = resolve;
        }),
    };
    render(bridge);
    await settle();
    render(undefined);
    await settle();
    complete(result);
    await settle();
    expect(JSON.stringify(render(undefined))).not.toContain("gpu1-A6000");
  });
});
