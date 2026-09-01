import { describe, expect, it, vi } from "vite-plus/test";

import {
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
  type WorkjetProjectPoolPort,
} from "./workjetProjectControl";

describe("requestWorkjetProjectControl", () => {
  it("pools once after not_active, retries once, and returns the successful response", async () => {
    const request = vi
      .fn<WorkjetProjectControlPort>()
      .mockResolvedValueOnce({ _tag: "failed", code: "not_active" })
      .mockResolvedValueOnce({
        _tag: "completed",
        response: { action: "project.list", projects: [] },
      });
    const ensurePooled = vi.fn<WorkjetProjectPoolPort>().mockResolvedValue({
      _tag: "ready",
      instanceId: "managed:welsch",
    });

    await expect(
      requestWorkjetProjectControl(
        "managed:welsch",
        { action: "project.list" },
        request,
        ensurePooled,
      ),
    ).resolves.toEqual({
      _tag: "completed",
      response: { action: "project.list", projects: [] },
    });
    expect(ensurePooled).toHaveBeenCalledExactlyOnceWith("managed:welsch");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "managed:welsch", { action: "project.list" });
    expect(request).toHaveBeenNthCalledWith(2, "managed:welsch", { action: "project.list" });
  });

  it("does not pool or request a third time after the retry is still not_active", async () => {
    const request = vi
      .fn<WorkjetProjectControlPort>()
      .mockResolvedValue({ _tag: "failed", code: "not_active" });
    const ensurePooled = vi.fn<WorkjetProjectPoolPort>().mockResolvedValue({
      _tag: "ready",
      instanceId: "managed:welsch",
    });

    await expect(
      requestWorkjetProjectControl(
        "managed:welsch",
        { action: "project.list" },
        request,
        ensurePooled,
      ),
    ).resolves.toEqual({ _tag: "failed", code: "not_active" });
    expect(ensurePooled).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
