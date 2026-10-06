import type { CtoxGuestStateEvent, DesktopCtoxBridge } from "@workjet/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createProjectRegistryRefresh,
  subscribeProjectRegistryWarmGuest,
} from "./projectRegistryRefresh";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("project registry recovery", () => {
  it("retains a readiness refresh arriving during a failed startup query", async () => {
    const initial = deferred();
    const results: string[] = [];
    const run = vi
      .fn()
      .mockImplementationOnce(async () => {
        await initial.promise;
        results.push("unsupported");
      })
      .mockImplementationOnce(async () => {
        results.push("loaded");
      });
    const controller = createProjectRegistryRefresh(run);
    const pending = controller.refresh();
    expect(controller.refresh()).toBe(pending);
    expect(controller.refresh()).toBe(pending);
    expect(run).toHaveBeenCalledOnce();
    initial.resolve();
    await pending;
    expect(run).toHaveBeenCalledTimes(2);
    expect(results).toEqual(["unsupported", "loaded"]);
  });

  it("coalesces another burst while the follow-up query is pending", async () => {
    const first = deferred();
    const second = deferred();
    const run = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValue(undefined);
    const controller = createProjectRegistryRefresh(run);
    const pending = controller.refresh();
    controller.refresh();
    first.resolve();
    await first.promise;
    controller.refresh();
    controller.refresh();
    second.resolve();
    await pending;
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("cancels queued work when the selected instance changes or the component unmounts", async () => {
    const initial = deferred();
    const run = vi.fn().mockImplementation(() => initial.promise);
    const controller = createProjectRegistryRefresh(run);
    const pending = controller.refresh();
    controller.refresh();
    controller.cancel();
    initial.resolve();
    await pending;
    await controller.refresh();
    expect(run).toHaveBeenCalledOnce();
  });

  it("allows a later explicit refresh after an unexpected rejected query", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("query failed"))
      .mockResolvedValue(undefined);
    const controller = createProjectRegistryRefresh(run);
    await expect(controller.refresh()).rejects.toThrow("query failed");
    await controller.refresh();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("refreshes only when the selected native guest becomes warm and releases its subscription", () => {
    let notify!: (event: CtoxGuestStateEvent) => void;
    const unsubscribe = vi.fn();
    const subscribe: NonNullable<DesktopCtoxBridge["onGuestState"]> = (listener) => {
      notify = listener;
      return unsubscribe;
    };
    const refresh = vi.fn();
    const stop = subscribeProjectRegistryWarmGuest("managed:welsch", refresh, subscribe);
    notify({ instanceId: "managed:welsch", state: "loading" });
    notify({ instanceId: "managed:other", state: "warm" });
    notify({ instanceId: "managed:welsch", state: "none" });
    expect(refresh).not.toHaveBeenCalled();
    notify({ instanceId: "managed:welsch", state: "warm" });
    expect(refresh).toHaveBeenCalledOnce();
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not require a native guest bridge on the web surface", () => {
    const refresh = vi.fn();
    subscribeProjectRegistryWarmGuest("managed:welsch", refresh, undefined)();
    expect(refresh).not.toHaveBeenCalled();
  });
});
