import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createKernel } from "./ctox/kernel/kernel.mjs";
import { KernelTransport } from "./ctox/kernel/transport.mjs";
import { bindKernelCtoxClient } from "./ctox/kernelClient";
import type { Kernel } from "./ctox/ctoxClient";
import {
  createSessionCalendarReader,
  type SessionCalendarSnapshot,
} from "./calendar/sessionCalendar";
let kernel: Kernel | undefined;
let unbind: (() => void) | undefined;
afterEach(async () => {
  unbind?.();
  unbind = undefined;
  await kernel?.close();
  kernel = undefined;
});

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
  it("reads sessions from the real local kernel without a guest or pool request", async () => {
    kernel = createKernel({
      instanceId: "fixture:session",
      userId: "owner",
      dbName: "p11b-session-reader",
      storage: "memory",
      multiTab: false,
      transport: new KernelTransport(),
    });
    await kernel.ready;
    unbind = bindKernelCtoxClient(kernel, "p11-b");
    await kernel.receivePage({
      epoch: "1",
      collection: "workjet_sessions",
      scope_hash: "local",
      gen: 1,
      cursor_to: "1",
      complete: true,
      docs: [
        {
          id: "s",
          seq: "1",
          rev: "1",
          data: {
            id: "s",
            project_id: "p",
            working_copy_id: "copy",
            computer_id: "machine",
            run_status: "paused",
            fence_epoch: 3,
            updated_at_ms: 1,
            created_at_ms: 0,
            is_deleted: false,
          },
        },
      ],
    });
    const request = vi.fn<WorkjetSessionControlPort>();
    const pool = vi.fn<WorkjetSessionPoolPort>();
    expect(await listWorkjetSessions("fixture:session", request, pool)).toMatchObject({
      _tag: "completed",
      response: {
        action: "session.list",
        sessions: [
          {
            id: "s",
            projectId: "p",
            workingCopyId: "copy",
            computerId: "machine",
            runStatus: "paused",
            fenceEpoch: 3,
            threadId: null,
            codingSessionId: null,
            activeTransferId: null,
          },
        ],
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(pool).not.toHaveBeenCalled();
    expect(await listWorkjetSessions("unbound:session", request, pool)).toEqual({
      _tag: "failed",
      code: "not_active",
    });
    const snapshots: SessionCalendarSnapshot[] = [];
    const reader = createSessionCalendarReader("fixture:session", (value) => snapshots.push(value));
    try {
      await reader.refresh();
      expect(snapshots.at(-1)?.sessions[0]?.runStatus).toBe("paused");
      await kernel.receivePage({
        epoch: "1",
        collection: "workjet_sessions",
        scope_hash: "local",
        gen: 1,
        cursor_to: "2",
        complete: true,
        docs: [
          {
            id: "s",
            seq: "2",
            rev: "2",
            data: {
              id: "s",
              project_id: "p",
              working_copy_id: "copy",
              computer_id: "machine",
              run_status: "running",
              fence_epoch: 4,
              updated_at_ms: 2,
              created_at_ms: 0,
              is_deleted: false,
            },
          },
        ],
      });
      expect(snapshots.at(-1)?.sessions[0]?.runStatus).toBe("running");
    } finally {
      reader.dispose();
    }
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
        { action: "session.create", commandId: "create", projectId: "p", workingCopyId: "copy" },
        request,
        ensurePooled,
      ),
    ).resolves.toEqual({ _tag: "failed", code: "not_active" });
    expect(ensurePooled).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves the unmigrated mutation and transfer-status helpers", async () => {
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

    await createWorkjetSession(instanceId, create, request);
    await startWorkjetSessionTransfer(instanceId, start, request);
    await readWorkjetSessionTransferStatus(instanceId, status, request);
    await abortWorkjetSessionTransfer(instanceId, abort, request);
    await acknowledgeWorkjetSessionPause(instanceId, acknowledge, request);

    expect(request).toHaveBeenNthCalledWith(1, instanceId, create);
    expect(request).toHaveBeenNthCalledWith(2, instanceId, start);
    expect(request).toHaveBeenNthCalledWith(3, instanceId, status);
    expect(request).toHaveBeenNthCalledWith(4, instanceId, abort);
    expect(request).toHaveBeenNthCalledWith(5, instanceId, acknowledge);
  });
});
