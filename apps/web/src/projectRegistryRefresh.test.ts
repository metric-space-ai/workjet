import type { CtoxGuestStateEvent, DesktopCtoxBridge } from "@workjet/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("project registry recovery", () => {
  it("backs off repeated failures up to one minute and cancels background recovery", async () => {
    const run = vi.fn(async () => false);
    const controller = createProjectRegistryRefresh(run);
    await controller.refresh();
    for (const delay of [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 60_000]) {
      const calls = run.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(run).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(calls + 1);
      expect(vi.getTimerCount()).toBe(1);
    }
    controller.cancel();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(8);
    expect(vi.getTimerCount()).toBe(0);
  });

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
