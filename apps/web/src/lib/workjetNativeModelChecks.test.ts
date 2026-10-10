import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkjetProjectControlPort } from "../workjetProjectControl";
import { checkInstanceModel } from "./workjetNativeProviders";

const modelId = "claude-opus-5-5";
const accountId = "196a89ba-ee86-4413-885c-04ca60e6f291";
const probe = { modelId, checkedAtMs: 1000, elapsedMs: 80, status: "ok", source: "upstream",
  failure: null, httpStatus: 200, retryAtMs: null } as const;
function portFor(changes: { operationId?: string; accountId?: string; accountRevision?: number } = {}) {
  return vi.fn<WorkjetProjectControlPort>().mockImplementation(async (_instance, request) => {
    if (request.action !== "instance.providers.models.check") throw new Error("Wrong action");
    return { _tag: "completed", response: { version: 1, action: request.action,
      operationId: request.operationId, accountId, accountRevision: 3, probe, ...changes } };
  });
}
afterEach(() => vi.useRealTimers());
describe("native instance model checks", () => {
  it("uses exact instance/account/model/current revision and returns only the typed observation", async () => {
    const port = portFor();
    await expect(checkInstanceModel("managed:welsch", accountId, 3, modelId,
      new AbortController().signal, port)).resolves.toEqual(probe);
    expect(port).toHaveBeenCalledTimes(1);
    expect(port.mock.calls[0]?.[0]).toBe("managed:welsch");
    expect(port.mock.calls[0]?.[1]).toMatchObject({ version: 1, action: "instance.providers.models.check",
      accountId, expectedAccountRevision: 3, modelId });
  });
  it("rejects a late receipt for another command/account or revision", async () => {
    for (const changes of [{ operationId: "b9d02120-303a-4a2f-bc90-a5afac342ab5" },
      { accountId: "another-logical-account" }, { accountRevision: 4 }])
      await expect(checkInstanceModel("managed:welsch", accountId, 3, modelId,
        new AbortController().signal, portFor(changes))).rejects.toThrow("another account");
  });
  it("aborts a retired UI consumer even if a successful receipt arrives afterwards", async () => {
    const controller = new AbortController();
    const port = portFor();
    const pending = checkInstanceModel("managed:welsch", accountId, 3, modelId, controller.signal, port);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it("times out once without retrying or claiming provider authentication failure", async () => {
    vi.useFakeTimers();
    const port = vi.fn<WorkjetProjectControlPort>().mockImplementation(() => new Promise(() => {}));
    const pending = checkInstanceModel("managed:welsch", accountId, 3, modelId,
      new AbortController().signal, port);
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(port).toHaveBeenCalledTimes(1);
  });
  it("preserves native connection diagnostics and redacts untyped provider exception text", async () => {
    const failure = { _tag: "failed", code: "guest_failed",
      preparation: { stage: "session", reason: "exception" } } as const;
    const failed = vi.fn<WorkjetProjectControlPort>().mockResolvedValue(failure);
    await expect(checkInstanceModel("managed:welsch", accountId, 3, modelId,
      new AbortController().signal, failed)).rejects.toMatchObject({ failure });
    const leaking = vi.fn<WorkjetProjectControlPort>().mockRejectedValue(new Error("private credential detail"));
    await expect(checkInstanceModel("managed:welsch", accountId, 3, modelId,
      new AbortController().signal, leaking)).rejects.toThrow("Native model check unavailable");
  });
});
