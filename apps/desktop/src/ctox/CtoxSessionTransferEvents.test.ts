// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, expect, it } from "vite-plus/test";

import {
  buildSessionTransferEventsRegistrationExpression,
  CtoxSessionTransferEventDecoder,
} from "./CtoxSessionTransferEvents.ts";

const event = {
  type: "workjet.session.transfer",
  transferId: "transfer-1",
  sessionId: "session-1",
  state: "pause_requested",
  fenceEpoch: 2,
  sourceComputerId: "computer-1",
  targetComputerId: "computer-2",
  deadlineAtMs: 1_788_000_040_000,
  updatedAtMs: 1_788_000_000_000,
} as const;

describe("CtoxSessionTransferEventDecoder", () => {
  it("counts rejected payloads and accepts exact bounded events", () => {
    const decoder = new CtoxSessionTransferEventDecoder();

    expect(decoder.decode(event)).toEqual(event);
    expect(decoder.decode({ ...event, fenceEpoch: -1 })).toBeUndefined();
    expect(decoder.decode({ ...event, extra: true })).toBeUndefined();
    expect(decoder.invalidCount).toBe(2);
  });

  it("builds a fixed registration and snapshot expression", () => {
    const expression = buildSessionTransferEventsRegistrationExpression([
      "computer-1",
      "computer-2",
    ]);

    expect(expression).toContain("globalThis.workjetSessionEvents");
    expect(expression).toContain("source.register");
    expect(expression).toContain("source.snapshot");
    expect(expression).toContain('["computer-1","computer-2"]');
    expect(expression).not.toContain("fetch(");
  });
});
