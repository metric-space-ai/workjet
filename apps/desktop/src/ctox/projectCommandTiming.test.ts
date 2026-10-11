// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, expect, it } from "vite-plus/test";
import * as NodeVM from "node:vm";
import { sanitizeProjectCommandTiming } from "./projectCommandTiming.ts";

describe("project command timing boundary", () => {
  it("retains completed numeric stages and rejects arbitrary data before IPC", () => {
    const sample = {
      commandId: "cmd_workjet_project_list_123-ab",
      stagesMs: {
        initial_capability: 3,
        fresh_peer_authority: 20,
        push: Number.NaN,
        native_processing: -1,
        total: 600_001,
        private: "private-value",
      },
      token: "private-value",
    };
    const expected = {
      commandId: sample.commandId,
      stagesMs: { initial_capability: 3, fresh_peer_authority: 20 },
    };
    expect(sanitizeProjectCommandTiming(sample)).toEqual(expected);
    const guest = NodeVM.runInNewContext(`(${sanitizeProjectCommandTiming.toString()})(sample)`, {
      sample,
    });
    expect(JSON.parse(JSON.stringify(guest))).toEqual(expected);
    expect(JSON.stringify(guest)).not.toContain("private-value");
  });
  it("retains only fixed unfinished preinsert intervals and supports fallback IDs", () => {
    expect(
      sanitizeProjectCommandTiming({
        commandId: "cmd_workjet_project_list_123_abc",
        stagesMs: {},
        pendingStage: "sync_readiness",
        pendingMs: 29000,
      }),
    ).toEqual({
      commandId: "cmd_workjet_project_list_123_abc",
      stagesMs: {},
      pendingStage: "sync_readiness",
      pendingMs: 29000,
    });
    expect(
      sanitizeProjectCommandTiming({
        commandId: "cmd_workjet_project_list_123",
        stagesMs: {},
        pendingStage: "private-value",
        pendingMs: 29000,
      }),
    ).toEqual({ commandId: "cmd_workjet_project_list_123", stagesMs: {} });
  });

  it("rejects unbounded or unrelated command identities and invalid samples", () => {
    for (const sample of [
      null,
      {},
      { commandId: "private?token=value", stagesMs: {} },
      { commandId: "cmd_workjet_project_list_123", stagesMs: "invalid" },
    ]) {
      expect(sanitizeProjectCommandTiming(sample)).toBeUndefined();
    }
  });
});
