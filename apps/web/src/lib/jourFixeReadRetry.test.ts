import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { retryJourFixeRead, JourFixeReadError, jourFixeTransportError } from "./jourFixeReadRetry";

describe("open-room read recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries serially at5/10/20/30 seconds and stops after five minutes", async () => {
    const entered: number[] = [];
    const read = vi.fn(async () => {
      entered.push(Date.now());
      throw new JourFixeReadError("guest_failed");
    });
    const result = retryJourFixeRead(read).catch((error) => error);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await result).toMatchObject({ code: "timeout" });
    expect(entered.map((time) => time - entered[0]!)).toEqual([
      0, 5_000, 15_000, 35_000, 65_000, 95_000, 125_000, 155_000, 185_000, 215_000, 245_000,
      275_000,
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["timeout", "request_timeout", "guest_failed"])(
    "recovers %s once it succeeds",
    async (code) => {
      const read = vi
        .fn()
        .mockRejectedValueOnce(new JourFixeReadError(code))
        .mockResolvedValue("loaded");
      const result = retryJourFixeRead(read);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBe("loaded");
      expect(read).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not issue another read while the previous read is still pending", async () => {
    let release!: (value: string) => void;
    const read = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const result = retryJourFixeRead(read);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    release("loaded");
    expect(await result).toBe("loaded");
  });

  it("bounds an unresponsive read without creating a second request", async () => {
    const read = vi.fn(() => new Promise<never>(() => {}));
    const result = retryJourFixeRead(read).catch((error) => error);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await result).toMatchObject({ code: "timeout" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the delay on room close and drops late results", async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => {
      throw new JourFixeReadError("timeout");
    });
    const result = retryJourFixeRead(read, { signal: controller.signal }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never retries denied access or an integrity failure", async () => {
    for (const error of [
      new JourFixeReadError("authentication_required"),
      new Error("integrity"),
    ]) {
      const read = vi.fn(async () => {
        throw error;
      });
      await expect(retryJourFixeRead(read)).rejects.toBe(error);
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps every guest_failed retryable even when it has a diagnostic reason", () => {
    expect(
      jourFixeTransportError({
        _tag: "failed",
        code: "guest_failed",
        diagnostic: { stage: "execute", reason: "peer_unavailable" },
      }),
    ).toMatchObject({ code: "guest_failed", message: "guest_failed" });
  });
});
