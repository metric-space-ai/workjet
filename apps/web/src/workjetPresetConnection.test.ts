import type { WorkjetConnectionSummary } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presetConnectionState, presetReadyConnection } from "./workjetPresetConnection";

const tenant = "322084e5-8239-48d7-b3c5-c5178fbe5822";
const selected = `managed:${tenant}`;
const source = (
  suffix: string,
  status: WorkjetConnectionSummary["status"],
  reason: string | null = null,
) =>
  ({
    connectionId: `ctox-dev-worker-source:${tenant}:${suffix}-7dcd-4c64-a0b7-e800251eb9a1`,
    instanceId: "welsch.ctox.dev",
    displayName: "Workjet worker source",
    source: "ctox_dev",
    status,
    reason,
  }) as WorkjetConnectionSummary;
const answered = { answered: true, slow: false };

describe("Presets connection state", () => {
  it("picks one of several ready worker sources of the same instance (Welsch, 16.10.)", () => {
    const rows = [
      source("d42d58fa", "ready"),
      source("2beedfc6", "ready"),
      source("c1728006", "ready"),
    ];
    const state = presetConnectionState(rows, selected, answered);
    expect(state.kind).toBe("ready");
    expect(state.kind === "ready" && state.connection.connectionId).toBe(rows[1]!.connectionId);
    expect(presetConnectionState(rows.toReversed(), selected, answered)).toEqual(state);
  });

  it("prefers the canonical tenant connection", () => {
    const canonical = { ...source("aaaaaaaa", "ready"), connectionId: `ctox-dev:${tenant}` };
    expect(presetReadyConnection([source("00000000", "ready"), canonical], selected)).toBe(
      canonical,
    );
  });

  it("never picks between ready connections of different native instances", () => {
    expect(
      presetConnectionState(
        [source("aaaaaaaa", "ready"), { ...source("bbbbbbbb", "ready"), instanceId: "x.ctox.dev" }],
        selected,
        answered,
      ),
    ).toEqual({ kind: "unreachable" });
  });

  it("ready wins over stale siblings", () => {
    expect(
      presetConnectionState(
        [source("aaaaaaaa", "needs_auth"), source("bbbbbbbb", "ready")],
        selected,
        answered,
      ).kind,
    ).toBe("ready");
  });

  it("maps needs_auth and authentication-required to the sign-in line", () => {
    expect(presetConnectionState([source("aaaaaaaa", "needs_auth")], selected, answered)).toEqual({
      kind: "authentication",
    });
    expect(
      presetConnectionState(
        [source("aaaaaaaa", "offline", "authentication-required")],
        selected,
        answered,
      ),
    ).toEqual({ kind: "authentication" });
  });

  it("maps offline, error and unsupported to the unreachable line", () => {
    for (const status of ["offline", "error", "unsupported"] as const)
      expect(presetConnectionState([source("aaaaaaaa", status)], selected, answered)).toEqual({
        kind: "unreachable",
      });
  });

  it("maps an answered list without a matching connection to the connect line", () => {
    expect(presetConnectionState([], selected, answered)).toEqual({ kind: "missing" });
    expect(
      presetConnectionState(
        [{ ...source("aaaaaaaa", "ready"), connectionId: "ctox-dev:other" }],
        selected,
        answered,
      ),
    ).toEqual({ kind: "missing" });
  });

  it("loads only until the first answer or 10 s, then shows the unreachable line", () => {
    expect(presetConnectionState(undefined, selected, { answered: false, slow: false })).toEqual({
      kind: "loading",
    });
    expect(presetConnectionState(undefined, selected, { answered: false, slow: true })).toEqual({
      kind: "unreachable",
    });
  });
});
