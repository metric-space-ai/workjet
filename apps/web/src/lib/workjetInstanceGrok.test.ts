import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkjetProjectControlPort } from "../workjetProjectControl";
import {
  requestInstanceGrok,
  grokVerificationLink,
  describeInstanceGrokFailure,
} from "./workjetInstanceGrok";
import { newCommandId } from "./utils";

function grokOperationId(input: Parameters<WorkjetProjectControlPort>[1]): string {
  if ("operationId" in input && input.action.startsWith("instance.grok.")) {
    return input.operationId;
  }
  throw new Error("Unexpected Grok request");
}

const readPort = vi.fn<WorkjetProjectControlPort>(async (_instance, input) => {
  if (input.action !== "instance.grok.read") throw new Error("Unexpected request");
  return {
    _tag: "completed",
    response: {
      version: 1,
      action: input.action,
      operationId: grokOperationId(input),
      installed: false,
      accountLabel: "Grok Build subscription",
      login: null,
      models: [],
      check: null,
    },
  };
});

describe("native instance Grok consumer", () => {
  it("shows the real catalog rejection and the exact existing sign-in actions", async () => {
    const port = vi.fn<WorkjetProjectControlPort>(async (_instance, input) => ({
      _tag: "completed",
      response: {
        version: 1,
        action: input.action,
        operationId: grokOperationId(input),
        installed: true,
        accountLabel: "Grok Build subscription",
        login: null,
        models: [],
        check: null,
        catalogError: { errorCode: "request_failed", upstream: { status: 401, stage: "catalog" } },
      },
    }));
    const response = await requestInstanceGrok(
      "managed:welsch",
      { action: "instance.grok.read" },
      new AbortController().signal,
      port,
    );
    expect(response.catalogError?.upstream).toEqual({ status: 401, stage: "catalog" });
    expect(response.check).toBeNull();
    expect(describeInstanceGrokFailure(response.catalogError!)).toContain("HTTP 401 · catalog");
    expect(describeInstanceGrokFailure(response.catalogError!)).toContain(
      "trash can, confirm, then choose Grok Build OAuth",
    );
  });
  it.each([
    [404, "catalog", "model catalog was not found", "Update the connected CTOX instance"],
    [404, "inference", "could not find this model", "Refresh models"],
    [403, "inference", "denied access", "subscription permissions"],
    [426, "catalog", "requires a newer Grok client", "Update the connected CTOX instance"],
    [429, "inference", "rate limited this request", "Retry later"],
    [502, "inference", "provider request failed", "Retry the check"],
  ] as const)(
    "classifies received HTTP %s at %s without inventing a cooldown",
    async (status, stage, diagnosis, action) => {
      const port = vi.fn<WorkjetProjectControlPort>(async (_instance, input) => ({
        _tag: "completed",
        response: {
          version: 1,
          action: input.action,
          operationId: grokOperationId(input),
          installed: true,
          accountLabel: "Grok Build subscription",
          login: null,
          models: ["grok-4.7"],
          check: {
            modelId: "grok-4.7",
            status: "error",
            checkedAt: 0,
            latencyMs: null,
            errorCode: "request_failed",
            upstream: { status, stage },
          },
        },
      }));
      const response = await requestInstanceGrok(
        "managed:welsch",
        { action: "instance.grok.check", modelId: "grok-4.7" },
        new AbortController().signal,
        port,
      );
      const message = describeInstanceGrokFailure(response.check!);
      expect(message).toContain(`HTTP ${status} · ${stage}`);
      expect(message).toContain(diagnosis);
      expect(message).toContain(action);
      expect(message).not.toContain("Available again");
      expect(message).not.toContain("expired");
    },
  );
  it.each([undefined, null])(
    "keeps old and local request failures unclassified (%s)",
    (upstream) => {
      const message = describeInstanceGrokFailure(
        upstream === undefined
          ? { errorCode: "request_failed" }
          : { errorCode: "request_failed", upstream },
      );
      expect(message).toContain("does not prove an expired login");
      expect(message).not.toContain("provider rejected");
      expect(message).not.toContain("HTTP");
    },
  );
  it.each([
    { status: 200, stage: "catalog" },
    { status: 600, stage: "inference" },
    { status: 401, stage: "unknown" },
  ])("rejects malformed upstream provenance %s", async (upstream) => {
    const port = vi.fn<WorkjetProjectControlPort>(async (_instance, input) => ({
      _tag: "completed",
      response: {
        version: 1,
        action: input.action,
        operationId: grokOperationId(input),
        installed: true,
        accountLabel: "Grok Build subscription",
        login: null,
        models: [],
        check: null,
        catalogError: { errorCode: "request_failed", upstream },
      },
    }));
    await expect(
      requestInstanceGrok(
        "managed:welsch",
        { action: "instance.grok.read" },
        new AbortController().signal,
        port,
      ),
    ).rejects.toThrow("Update the connected CTOX instance");
  });
  it("preserves the typed instance preparation failure through the account consumer", async () => {
    const failure = {
      _tag: "failed",
      code: "guest_failed",
      preparation: { stage: "session", reason: "exception" },
    } as const;
    const port = vi.fn<WorkjetProjectControlPort>().mockResolvedValue(failure);
    await expect(
      requestInstanceGrok(
        "managed:welsch",
        { action: "instance.grok.read" },
        new AbortController().signal,
        port,
      ),
    ).rejects.toMatchObject({ failure });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });
  it("uses only the selected instance and correlates its native receipt", async () => {
    const result = await requestInstanceGrok(
      "managed:welsch",
      { action: "instance.grok.read" },
      new AbortController().signal,
      readPort,
    );
    expect(readPort).toHaveBeenCalledWith(
      "managed:welsch",
      expect.objectContaining({ action: "instance.grok.read", version: 1 }),
    );
    expect(result.installed).toBe(false);
    expect(result.check).toBeNull();
  });
  it("rejects a receipt from another operation", async () => {
    const port = vi.fn<WorkjetProjectControlPort>(async (_instance, input) => {
      if (input.action !== "instance.grok.read") throw new Error("Unexpected request");
      return {
        _tag: "completed",
        response: {
          version: 1,
          action: input.action,
          operationId: newCommandId(),
          installed: false,
          accountLabel: "Grok Build subscription",
          login: null,
          models: [],
          check: null,
        },
      };
    });
    await expect(
      requestInstanceGrok(
        "managed:welsch",
        { action: "instance.grok.read" },
        new AbortController().signal,
        port,
      ),
    ).rejects.toThrow("another request");
  });
  it("bounds a hung native transport without applying a late receipt", async () => {
    vi.useFakeTimers();
    const port = vi.fn<WorkjetProjectControlPort>(() => new Promise(() => {}));
    const pending = requestInstanceGrok(
      "managed:welsch",
      { action: "instance.grok.read" },
      new AbortController().signal,
      port,
    );
    const assertion = expect(pending).rejects.toThrow("did not respond in time");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
  it("cancels a pending request when the selected instance scope is retired", async () => {
    const port = vi.fn<WorkjetProjectControlPort>(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = requestInstanceGrok(
      "managed:welsch",
      { action: "instance.grok.read" },
      controller.signal,
      port,
    );
    const assertion = expect(pending).rejects.toThrow("Cancelled");
    controller.abort();
    await assertion;
  });

  it("cancels the exact native device login when a retired start replies late", async () => {
    let finish: (value: Awaited<ReturnType<WorkjetProjectControlPort>>) => void = () => {
      throw new Error("Start not dispatched");
    };
    let operationId: string = newCommandId();
    const loginId = newCommandId();
    const port = vi.fn<WorkjetProjectControlPort>(async (_instance, input) => {
      if (input.action === "instance.grok.start") {
        operationId = input.operationId;
        return await new Promise((resolve) => {
          finish = resolve;
        });
      }
      if (input.action !== "instance.grok.cancel" || input.loginId !== loginId)
        throw new Error("Foreign cancellation");
      return {
        _tag: "completed",
        response: {
          version: 1,
          action: input.action,
          operationId: grokOperationId(input),
          installed: false,
          accountLabel: "Grok Build subscription",
          login: null,
          models: [],
          check: null,
        },
      };
    });
    const controller = new AbortController();
    const pending = requestInstanceGrok(
      "managed:welsch",
      { action: "instance.grok.start" },
      controller.signal,
      port,
    );
    const assertion = expect(pending).rejects.toThrow("Cancelled");
    controller.abort();
    await assertion;
    finish({
      _tag: "completed",
      response: {
        version: 1,
        action: "instance.grok.start",
        operationId,
        installed: false,
        accountLabel: "Grok Build subscription",
        login: {
          loginId,
          phase: "pending",
          verificationUri: "https://auth.grok.com/device",
          userCode: "public-code",
          expiresAt: Date.now() + 60_000,
        },
        models: [],
        check: null,
      },
    });
    await vi.waitFor(() =>
      expect(port).toHaveBeenCalledWith(
        "managed:welsch",
        expect.objectContaining({ action: "instance.grok.cancel", loginId }),
      ),
    );
    expect(port).toHaveBeenCalledTimes(2);
  });
  it("does not echo private transport errors", async () => {
    const port = vi.fn<WorkjetProjectControlPort>(async () => {
      throw new Error("private-fixture-token");
    });
    await expect(
      requestInstanceGrok(
        "managed:welsch",
        { action: "instance.grok.read" },
        new AbortController().signal,
        port,
      ),
    ).rejects.toThrow("Check the instance connection");
  });
  it("opens only a credential-free HTTPS verification link", () => {
    expect(grokVerificationLink("https://auth.grok.com/device")).toBe(
      "https://auth.grok.com/device",
    );
    expect(grokVerificationLink("javascript:alert(1)")).toBeNull();
    expect(grokVerificationLink("https://user:secret@auth.grok.com/device")).toBeNull();
  });
});
