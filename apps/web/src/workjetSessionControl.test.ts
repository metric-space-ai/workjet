import { describe, expect, it, vi } from "vite-plus/test";

import {
  abortWorkjetSessionTransfer,
  acknowledgeWorkjetSessionPause,
  createWorkjetSession,
  listWorkjetSessions,
  readWorkjetSessionTransferStatus,
  requestWorkjetSessionControl,
  startWorkjetSessionTransfer,
  type WorkjetSessionControlPort,
  type WorkjetSessionPoolPort,
} from "./workjetSessionControl";

describe("requestWorkjetSessionControl", () => {
  it("pools once after not_active, retries once, and returns the successful response", async () => {
    const request = vi
      .fn<WorkjetSessionControlPort>()
      .mockResolvedValueOnce({ _tag: "failed", code: "not_active" })
      .mockResolvedValueOnce({
        _tag: "completed",
        response: { action: "session.list", sessions: [] },
      });
    const ensurePooled = vi.fn<WorkjetSessionPoolPort>().mockResolvedValue({
      _tag: "ready",
      instanceId: "managed:welsch",
    });

    await expect(
      requestWorkjetSessionControl(
        "managed:welsch",
        { action: "session.list" },
        request,
        ensurePooled,
      ),
    ).resolves.toEqual({
      _tag: "completed",
      response: { action: "session.list", sessions: [] },
    });
    expect(ensurePooled).toHaveBeenCalledExactlyOnceWith("managed:welsch");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "managed:welsch", { action: "session.list" });
    expect(request).toHaveBeenNthCalledWith(2, "managed:welsch", { action: "session.list" });
  });

  it("does not pool or request a third time after the retry is still not_active", async () => {
    const request = vi
      .fn<WorkjetSessionControlPort>()
      .mockResolvedValue({ _tag: "failed", code: "not_active" });
    const ensurePooled = vi.fn<WorkjetSessionPoolPort>().mockResolvedValue({
      _tag: "ready",
      instanceId: "managed:welsch",
    });

    await expect(
      requestWorkjetSessionControl(
        "managed:welsch",
        { action: "session.list" },
        request,
        ensurePooled,
      ),
    ).resolves.toEqual({ _tag: "failed", code: "not_active" });
    expect(ensurePooled).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("forwards each helper action through the session control port", async () => {
    const request = vi.fn<WorkjetSessionControlPort>().mockResolvedValue({
      _tag: "completed",
      response: { action: "session.list", sessions: [] },
    });
    const instanceId = "managed:welsch";
    const create = {
      action: "session.create",
      commandId: "command-create",
      projectId: "project-1",
      workingCopyId: "copy-1",
    } as const;
    const start = {
      action: "session.transfer.start",
      commandId: "command-start",
      sessionId: "session-1",
      targetComputerId: "computer-2",
      targetPath: "/srv/workjet",
      idempotencyKey: "start-1",
    } as const;
    const status = {
      action: "session.transfer.status",
      commandId: "command-status",
      transferId: "transfer-1",
    } as const;
    const abort = {
      action: "session.transfer.abort",
      commandId: "command-abort",
      transferId: "transfer-1",
      reason: "operator requested abort",
      idempotencyKey: "abort-1",
    } as const;
    const acknowledge = {
      action: "session.transfer.pause_ack",
      commandId: "command-acknowledge",
      transferId: "transfer-1",
      computerId: "computer-1",
      fenceEpoch: 3,
      lastTerminalTurnId: "turn-1",
      gitRepository: true,
      idempotencyKey: "pause-1",
    } as const;

    await listWorkjetSessions(instanceId, request);
    await createWorkjetSession(instanceId, create, request);
    await startWorkjetSessionTransfer(instanceId, start, request);
    await readWorkjetSessionTransferStatus(instanceId, status, request);
    await abortWorkjetSessionTransfer(instanceId, abort, request);
    await acknowledgeWorkjetSessionPause(instanceId, acknowledge, request);

    expect(request).toHaveBeenNthCalledWith(1, instanceId, { action: "session.list" });
    expect(request).toHaveBeenNthCalledWith(2, instanceId, create);
    expect(request).toHaveBeenNthCalledWith(3, instanceId, start);
    expect(request).toHaveBeenNthCalledWith(4, instanceId, status);
    expect(request).toHaveBeenNthCalledWith(5, instanceId, abort);
    expect(request).toHaveBeenNthCalledWith(6, instanceId, acknowledge);
  });
});
