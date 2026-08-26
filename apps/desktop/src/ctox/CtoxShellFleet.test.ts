// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { CtoxShellFleetRow } from "@t3tools/contracts";
import { describe, it } from "@effect/vitest";
import { expect } from "vite-plus/test";

import { CTOX_SHELL_FLEET_ROLLOUT_POLICY, planCtoxShellRolloutWaves } from "./CtoxShellFleet.ts";

function row(
  instanceId: string,
  displayName: string,
  source: CtoxShellFleetRow["source"] = "ssh_managed",
): CtoxShellFleetRow {
  return {
    instanceId,
    displayName,
    source,
    reachable: true,
    backendVersion: "0.3.22",
    shell: {
      activeVersion: "0.1.0",
      desiredVersion: null,
      latestCompatibleVersion: "0.1.1",
      channel: "stable",
      phase: "available",
      health: "healthy",
      administrable: true,
      recoveryShell: false,
      lastCheckedAt: "2026-08-26T00:00:00Z",
      lastActivatedAt: null,
      errorCode: null,
      pause: null,
    },
    blocker: null,
    requiredOperatorStep: null,
  };
}

describe("planCtoxShellRolloutWaves", () => {
  it("puts the local canary first and GPU3 second", () => {
    const rows = [
      row("gpu1", "GPU1 A6000"),
      row("gpu3", "GPU3 A4500"),
      row("local", "Local CTOX", "local_daemon"),
      row("other", "Office"),
    ];
    expect(planCtoxShellRolloutWaves(rows)).toEqual([["local"], ["gpu3"], ["gpu1"], ["other"]]);
  });

  it("excludes current, paused and non-administrable rows", () => {
    const current = row("current", "Current");
    const paused = row("paused", "Paused");
    const blocked = row("blocked", "Blocked");
    expect(
      planCtoxShellRolloutWaves([
        { ...current, shell: { ...current.shell, phase: "current" } },
        { ...paused, blocker: "paused" },
        { ...blocked, shell: { ...blocked.shell, administrable: false } },
      ]),
    ).toEqual([]);
  });

  it("caps later waves at both 25 percent and three instances", () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(`host-${index}`, `Host ${index}`));
    const waves = planCtoxShellRolloutWaves(rows);
    expect(waves.every((wave) => wave.length <= 3)).toBe(true);
    expect(waves.flat()).toHaveLength(20);
  });

  it("guards the production rollout cadence and retry budget", () => {
    expect(CTOX_SHELL_FLEET_ROLLOUT_POLICY).toEqual({
      startupDelay: "30 seconds",
      checkInterval: "6 hours",
      localCanaryObservation: "10 minutes",
      waveObservation: "15 minutes",
      automaticRetryCount: 1,
    });
  });
});
