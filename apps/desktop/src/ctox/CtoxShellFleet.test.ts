// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { CtoxShellFleetRow } from "@t3tools/contracts";
import { describe, it } from "@effect/vitest";
import { expect } from "vite-plus/test";

import {
  ctoxShellFleetRowFromStatus,
  CTOX_SHELL_FLEET_ROLLOUT_POLICY,
  parseCtoxBackendVersion,
  parseCtoxDataPlaneProbe,
  planCtoxShellRolloutWaves,
} from "./CtoxShellFleet.ts";

describe("parseCtoxBackendVersion", () => {
  it("accepts the CTOX version document and rejects display text", () => {
    expect(parseCtoxBackendVersion(JSON.stringify({ version: "0.3.22" }))).toBe("0.3.22");
    expect(() => parseCtoxBackendVersion("ctox 0.3.22")).toThrow();
    expect(() => parseCtoxBackendVersion(JSON.stringify({ version: "latest" }))).toThrow();
  });
});

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

describe("parseCtoxDataPlaneProbe", () => {
  const status = {
    running: true,
    replicationUp: true,
    heartbeat: { fresh: true },
    health: { errorTotal: 0 },
    health_stages: {
      process_alive: true,
      signaling_socket_connected: true,
      signaling_join_accepted: true,
      peer_authenticated: true,
      data_channel_open: true,
      command_consumer_alive: true,
    },
  };

  it("requires the authenticated browser data channel, not replicationUp alone", () => {
    expect(parseCtoxDataPlaneProbe(JSON.stringify(status))).toEqual({
      nativePeerObserved: true,
      dataPlaneReady: true,
    });
    expect(
      parseCtoxDataPlaneProbe(
        JSON.stringify({
          ...status,
          health_stages: { ...status.health_stages, data_channel_open: false },
        }),
      ),
    ).toEqual({ nativePeerObserved: true, dataPlaneReady: false });
  });

  it("fails closed for stale or unhealthy native peers", () => {
    expect(
      parseCtoxDataPlaneProbe(JSON.stringify({ ...status, heartbeat: { fresh: false } })),
    ).toEqual({ nativePeerObserved: false, dataPlaneReady: false });
    expect(() => parseCtoxDataPlaneProbe("[]")).toThrow();
  });
});

describe("ctoxShellFleetRowFromStatus", () => {
  it("preserves the active shell while the data plane is degraded", () => {
    const current = row("local", "Local CTOX", "local_daemon");
    const result = ctoxShellFleetRowFromStatus({
      instance: {
        id: current.instanceId,
        displayName: current.displayName,
        source: current.source,
        status: "available",
        healthSummary: {
          dataPlane: "rxdb-webrtc",
          dataPlaneReady: false,
          httpDataProxy: false,
          nativePeerObserved: false,
        },
      },
      shell: { ...current.shell, activeVersion: "0.1.5", phase: "restart" },
      dataPlane: { nativePeerObserved: true, dataPlaneReady: false },
    });
    expect(result.shell.activeVersion).toBe("0.1.5");
    expect(result.shell.recoveryShell).toBe(false);
    expect(result.blocker).toBe("data_plane_degraded");
    expect(result.shell.health).toBe("degraded");
  });

  it("reports healthy after the authenticated browser data channel probe succeeds", () => {
    const current = row("local", "Local CTOX", "local_daemon");
    const result = ctoxShellFleetRowFromStatus({
      instance: {
        id: current.instanceId,
        displayName: current.displayName,
        source: current.source,
        status: "available",
        healthSummary: {
          dataPlane: "rxdb-webrtc",
          dataPlaneReady: true,
          httpDataProxy: false,
          nativePeerObserved: true,
        },
      },
      shell: { ...current.shell, health: "degraded" },
      dataPlane: { nativePeerObserved: true, dataPlaneReady: true },
    });
    expect(result.blocker).toBeNull();
    expect(result.shell.health).toBe("healthy");
  });
});
