import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkjetProjectControlPort } from "../workjetProjectControl";
import { requestInstanceGrok, grokVerificationLink } from "./workjetInstanceGrok";
import { newCommandId } from "./utils";

const readPort = vi.fn<WorkjetProjectControlPort>(async (_instance, input) => {
  if (input.action !== "instance.grok.read") throw new Error("Unexpected request");
  return {
    _tag: "completed",
    response: {
      version: 1,
      action: input.action,
      operationId: input.operationId,
      installed: false,
      accountLabel: "Grok Build subscription",
      login: null,
      models: [],
      check: null,
    },
  };
});

describe("native instance Grok consumer", () => {
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
          operationId: input.operationId,
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
