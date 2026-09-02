import { describe, expect, it } from "vite-plus/test";

import {
  buildPauseAcknowledgementRequest,
  pauseWaitTimeoutMs,
  WORKJET_SESSION_PAUSE_WAIT_MAX_MS,
} from "./useWorkjetSessionPauseObserver";

const notification = {
  instanceId: "managed:welsch",
  event: {
    type: "workjet.session.transfer",
    transferId: "transfer-1",
    sessionId: "session-1",
    state: "pause_requested",
    fenceEpoch: 7,
    sourceComputerId: "computer-1",
    targetComputerId: "computer-2",
    deadlineAtMs: 1_788_000_040_000,
    updatedAtMs: 1_788_000_000_000,
  },
} as const;

describe("useWorkjetSessionPauseObserver support logic", () => {
  it("caps stillness waits at forty seconds and honors earlier deadlines", () => {
    expect(pauseWaitTimeoutMs(100_000, 10_000)).toBe(WORKJET_SESSION_PAUSE_WAIT_MAX_MS);
    expect(pauseWaitTimeoutMs(25_000, 10_000)).toBe(15_000);
    expect(pauseWaitTimeoutMs(9_000, 10_000)).toBe(0);
  });

  it("preserves the transfer fence and terminal turn in pause acknowledgements", () => {
    expect(
      buildPauseAcknowledgementRequest({
        notification,
        localComputerId: "computer-1",
        lastTerminalTurnId: "turn-9",
        gitRepository: true,
      }),
    ).toMatchObject({
      action: "session.transfer.pause_ack",
      transferId: "transfer-1",
      computerId: "computer-1",
      fenceEpoch: 7,
      lastTerminalTurnId: "turn-9",
      gitRepository: true,
      idempotencyKey: expect.any(String),
      commandId: expect.any(String),
    });
  });
});
