import { describe, expect, it, vi } from "vite-plus/test";

import {
  listWorkjetProjects,
  describeWorkjetProjectControlFailure,
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
  type WorkjetProjectPoolPort,
} from "./workjetProjectControl";

describe("project instance failure display", () => {
  it("distinguishes hosted sign-in from accountless paired authentication", () => {
    const failure = { _tag: "failed", code: "authentication_required" } as const;
    expect(describeWorkjetProjectControlFailure(failure, "managed:tenant")).toContain(
      "Sign in to ctox.dev",
    );
    expect(describeWorkjetProjectControlFailure(failure, "paired:tenant")).not.toContain(
      "ctox.dev",
    );
  });
  it("shows fixed discovery error and HTTP status", () => {
    expect(
      describeWorkjetProjectControlFailure({
        _tag: "failed",
        code: "guest_failed",
        discovery: { code: "http_error", httpStatus: 503 },
      }),
    ).toContain("http_error (HTTP 503)");
  });
  it("asks for the connected shell update when its action is unsupported", () => {
    expect(describeWorkjetProjectControlFailure({ _tag: "failed", code: "unsupported" })).toBe(
      "The connected CTOX instance does not support this action. Update its Business OS shell.",
    );
  });
});

describe("listWorkjetProjects", () => {
  const result = {
    _tag: "completed",
    response: { action: "project.list", projects: [], count: 0, truncated: false },
  } as const;

  it("requests configuration from the selected instance", async () => {
    const request = vi.fn<WorkjetProjectControlPort>().mockResolvedValue(result);
    await expect(listWorkjetProjects("managed:selected", request)).resolves.toEqual(result);
    expect(request).toHaveBeenCalledExactlyOnceWith("managed:selected", {
      action: "project.list",
      includeConfiguration: true,
      includeSupervisorLuma: true,
    });
  });

  it.each(["unsupported", "guest_failed"] as const)(
    "falls back to the same guest's configured projection for %s",
    async (code) => {
      const request = vi
        .fn<WorkjetProjectControlPort>()
        .mockResolvedValueOnce({ _tag: "failed", code })
        .mockResolvedValueOnce(result);
      await expect(listWorkjetProjects("managed:selected", request)).resolves.toEqual(result);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(2, "managed:selected", {
        action: "project.list", includeConfiguration: true,
      });
    },
  );

  it("keeps a bounded legacy fallback for shells without either additive flag", async () => {
    const request = vi.fn<WorkjetProjectControlPort>()
      .mockResolvedValueOnce({ _tag: "failed", code: "unsupported" })
      .mockResolvedValueOnce({ _tag: "failed", code: "unsupported" })
      .mockResolvedValueOnce(result);
    await expect(listWorkjetProjects("managed:selected", request)).resolves.toEqual(result);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(3, "managed:selected", { action: "project.list" });
  });

  it("does not repeat a failed account discovery as a legacy project query", async () => {
    const result = {
      _tag: "failed",
      code: "guest_failed",
      discovery: { code: "network_error" },
    } as const;
    const request = vi.fn<WorkjetProjectControlPort>().mockResolvedValue(result);
    await expect(listWorkjetProjects("managed:selected", request)).resolves.toEqual(result);
    expect(request).toHaveBeenCalledOnce();
  });

  it("preserves authentication failure without retrying a denied request", async () => {
    const result = { _tag: "failed", code: "authentication_required" } as const;
    const request = vi.fn<WorkjetProjectControlPort>().mockResolvedValue(result);
    await expect(listWorkjetProjects("managed:selected", request)).resolves.toEqual(result);
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("requestWorkjetProjectControl", () => {
  it("pools once after not_active, retries once, and returns the successful response", async () => {
    const request = vi
      .fn<WorkjetProjectControlPort>()
      .mockResolvedValueOnce({ _tag: "failed", code: "not_active" })
      .mockResolvedValueOnce({
        _tag: "completed",
        response: { action: "project.list", projects: [], count: 0, truncated: false },
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
      response: { action: "project.list", projects: [], count: 0, truncated: false },
    });
    expect(ensurePooled).toHaveBeenCalledExactlyOnceWith("managed:welsch");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "managed:welsch", { action: "project.list" });
    expect(request).toHaveBeenNthCalledWith(2, "managed:welsch", { action: "project.list" });
  });

  it("preserves a failed launch without sending another project request", async () => {
    const request = vi.fn<WorkjetProjectControlPort>().mockResolvedValue({
      _tag: "failed",
      code: "not_active",
    });
    const ensurePooled = vi.fn<WorkjetProjectPoolPort>().mockResolvedValue({
      _tag: "failed",
      code: "launch_failed",
    });
    await expect(
      requestWorkjetProjectControl(
        "local:workstation",
        { action: "project.list" },
        request,
        ensurePooled,
      ),
    ).resolves.toEqual({ _tag: "failed", code: "launch_failed" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects preparation of a different instance", async () => {
    const request = vi.fn<WorkjetProjectControlPort>().mockResolvedValue({
      _tag: "failed",
      code: "not_active",
    });
    const ensurePooled = vi.fn<WorkjetProjectPoolPort>().mockResolvedValue({
      _tag: "ready",
      instanceId: "managed:other",
    });
    await expect(
      requestWorkjetProjectControl(
        "managed:selected",
        { action: "project.list" },
        request,
        ensurePooled,
      ),
    ).resolves.toEqual({ _tag: "failed", code: "not_active" });
    expect(request).toHaveBeenCalledOnce();
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
