import { CommandId } from "@workjet/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  listWorkjetProjects,
  describeWorkjetProjectControlFailure,
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
  type WorkjetProjectPoolPort,
} from "./workjetProjectControl";

describe("project instance failure display", () => {
  it.each(["instance_disabled", "instance_removed"] as const)(
    "keeps %s as a quiet state and never falls back to another query",
    async (code) => {
      const failure = { _tag: "failed", code } as const;
      const request = vi.fn<WorkjetProjectControlPort>().mockResolvedValue(failure);
      await expect(
        requestWorkjetProjectControl(
          "managed:fixture",
          {
            action: "project.gallery.order.set",
            commandId: CommandId.make("read"),
            operationId: "set-order",
            expectedRevision: 0,
            projectIds: [],
          },
          request,
        ),
      ).resolves.toEqual(failure);
      expect(request).toHaveBeenCalledOnce();
      expect(describeWorkjetProjectControlFailure(failure, null, "de")).toBe(
        code === "instance_disabled" ? "Instanz deaktiviert." : "Instanz entfernt.",
      );
    },
  );

  it("answers every language request with the German wording", () => {
    const failure = { _tag: "failed", code: "instance_disabled" } as const;
    expect(describeWorkjetProjectControlFailure(failure, null, "en")).toBe("Instanz deaktiviert.");
    expect(describeWorkjetProjectControlFailure(failure, null)).toBe("Instanz deaktiviert.");
    expect(
      describeWorkjetProjectControlFailure({ _tag: "failed", code: "timeout" }, null, "en"),
    ).toBe("Die Instanz hat nicht rechtzeitig geantwortet.");
  });

  it("distinguishes hosted sign-in from accountless paired authentication", () => {
    const failure = { _tag: "failed", code: "authentication_required" } as const;
    expect(describeWorkjetProjectControlFailure(failure, "managed:tenant", "en")).toContain(
      "Bei ctox.dev anmelden",
    );
    expect(describeWorkjetProjectControlFailure(failure, "paired:tenant", "en")).not.toContain(
      "ctox.dev",
    );
  });
  it("explains discovery failure without exposing its raw code", () => {
    expect(
      describeWorkjetProjectControlFailure(
        {
          _tag: "failed",
          code: "guest_failed",
          discovery: { code: "http_error", httpStatus: 503 },
        },
        null,
        "en",
      ),
    ).toBe("Die Instanz konnte nicht erreicht werden.");
  });
  it("asks for the connected shell update when its action is unsupported", () => {
    expect(
      describeWorkjetProjectControlFailure({ _tag: "failed", code: "unsupported" }, null, "en"),
    ).toBe("Die Instanz unterstützt diese Aktion noch nicht. Business-OS-Shell aktualisieren.");
  });
  it("explains a classified data-plane timeout without showing guest exception text", () => {
    expect(
      describeWorkjetProjectControlFailure(
        {
          _tag: "failed",
          code: "guest_failed",
          diagnostic: { stage: "execute", reason: "request_timeout" },
        },
        null,
        "en",
      ),
    ).toBe("Die Datenabfrage hat zu lange gedauert.");
  });
});

describe("local project reads", () => {
  it("does not fall back to a guest when no V4 client is mounted", async () => {
    const request = vi.fn<WorkjetProjectControlPort>();
    expect(await listWorkjetProjects("unmounted", request)).toEqual({
      _tag: "failed",
      code: "not_active",
    });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("requestWorkjetProjectControl", () => {
  it("pools once after not_active, retries once, and returns the successful response", async () => {
    const request = vi
      .fn<WorkjetProjectControlPort>()
      .mockResolvedValueOnce({ _tag: "failed", code: "not_active" })
      .mockResolvedValueOnce({
        _tag: "completed",
        response: {
          action: "project.gallery.order.set",
          commandId: CommandId.make("read"),
          contract: "ctox.workjet.project_gallery_order.v1",
          order: { revision: 0, projectIds: [] },
        },
      });
    const ensurePooled = vi.fn<WorkjetProjectPoolPort>().mockResolvedValue({
      _tag: "ready",
      instanceId: "managed:welsch",
    });

    await expect(
      requestWorkjetProjectControl(
        "managed:welsch",
        {
          action: "project.gallery.order.set",
          commandId: CommandId.make("read"),
          operationId: "set-order",
          expectedRevision: 0,
          projectIds: [],
        },
        request,
        ensurePooled,
      ),
    ).resolves.toEqual({
      _tag: "completed",
      response: {
        action: "project.gallery.order.set",
        commandId: CommandId.make("read"),
        contract: "ctox.workjet.project_gallery_order.v1",
        order: { revision: 0, projectIds: [] },
      },
    });
    expect(ensurePooled).toHaveBeenCalledExactlyOnceWith("managed:welsch");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "managed:welsch", {
      action: "project.gallery.order.set",
      operationId: "set-order",
      expectedRevision: 0,
      projectIds: [],
      commandId: CommandId.make("read"),
    });
    expect(request).toHaveBeenNthCalledWith(2, "managed:welsch", {
      action: "project.gallery.order.set",
      operationId: "set-order",
      expectedRevision: 0,
      projectIds: [],
      commandId: CommandId.make("read"),
    });
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
        {
          action: "project.gallery.order.set",
          commandId: CommandId.make("read"),
          operationId: "set-order",
          expectedRevision: 0,
          projectIds: [],
        },
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
        {
          action: "project.gallery.order.set",
          commandId: CommandId.make("read"),
          operationId: "set-order",
          expectedRevision: 0,
          projectIds: [],
        },
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
        {
          action: "project.gallery.order.set",
          commandId: CommandId.make("read"),
          operationId: "set-order",
          expectedRevision: 0,
          projectIds: [],
        },
        request,
        ensurePooled,
      ),
    ).resolves.toEqual({ _tag: "failed", code: "not_active" });
    expect(ensurePooled).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
