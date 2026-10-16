import type { EnvironmentId } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createLegacyMachineEnrollment,
  legacyErrorCode,
  legacyMachineCandidates,
  requestForCandidate,
  type AddComputerPhase,
} from "./legacyMachineEnrollment";
import {
  machineEnrollmentProgress,
  parseManualAddress,
  startMachineEnrollment,
  type MachineEnrollmentSnapshot,
} from "./machineEnrollment";
import { activeSshPasswordClaims, claimedSshPassword, claimSshPassword } from "./sshPasswordOnce";

const env = "env-gpu1" as EnvironmentId;
const host = (alias: string, hostname: string, username: string | null) => ({
  alias,
  hostname,
  username,
  port: 22,
  source: "ssh-config" as const,
});

function clock() {
  const queue: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => void queue.push(fn),
    flush: () => {
      for (let i = 0; queue.length > 0 && i < 100; i += 1) queue.shift()!();
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Quellenliste über den heutigen Weg", () => {
  it("lists this computer, config hosts and tailnet devices once, users from ~/.ssh/config", () => {
    const candidates = legacyMachineCandidates({
      localName: "MacBook Pro",
      sshHosts: [
        host("ts-gpu1", "100.87.204.48", "deck"),
        host("lan-gpu3", "192.168.1.30", "metricspace"),
        host("*.internal", "*.internal", null),
        { ...host("old", "1.2.3.4", null), source: "known-hosts" },
      ],
      peers: {
        status: "available",
        peers: [
          { id: "1", name: "gpu1-a6000", hostname: "100.87.204.48", online: true },
          { id: "2", name: "nas.tail", hostname: "100.64.0.28", online: true },
          { id: "3", name: "off", hostname: "100.1.1.1", online: false },
        ],
      },
    });
    expect(candidates.map((entry) => [entry.id, entry.user, entry.sshAlias])).toEqual([
      ["local", null, null],
      ["ssh:lan-gpu3", "metricspace", "lan-gpu3"],
      ["tailscale:gpu1-a6000", "deck", "ts-gpu1"],
      ["tailscale:nas", null, null],
    ]);
  });

  it("builds an add request without roles; GPU stays auto-detected", () => {
    const request = requestForCandidate(
      {
        id: "tailscale:nas",
        transport: "tailscale",
        name: "nas",
        user: "admin",
        host: "100.64.0.28",
        port: null,
        sshAlias: null,
      },
      "nas",
    );
    expect(request).toMatchObject({
      kind: "tailscale",
      target: { alias: "100.64.0.28", hostname: "100.64.0.28", username: "admin" },
      roles: { build: false, storage: false, gpu: false },
      gpuDecided: false,
    });
  });

  it("parses manual addresses with optional port", () => {
    expect(parseManualAddress("192.168.1.10")).toEqual({ host: "192.168.1.10", port: null });
    expect(parseManualAddress("gpu4:2222")).toEqual({ host: "gpu4", port: 2222 });
    expect(parseManualAddress("[fe80::1]:22")).toEqual({ host: "fe80::1", port: 22 });
    expect(parseManualAddress("a b")).toBeNull();
    expect(parseManualAddress("x:99999")).toBeNull();
  });
});

describe("Schritte aus dem heutigen Weg", () => {
  it("maps addComputer phases onto the 8 steps and turns green once the computer is online", async () => {
    const tick = clock();
    let online = false;
    const { source, transport } = createLegacyMachineEnrollment({
      listSshHosts: async () => [],
      localName: null,
      schedule: tick.schedule,
      isOnline: () => online,
      add: async (_request, phase: AddComputerPhase) => {
        for (const key of [
          "transport_connected",
          "package_copied",
          "installed",
          "service_started",
          "device_bound",
        ] as const) {
          phase(key, "running");
          phase(key, "done");
        }
        return { status: "done", environmentId: env };
      },
    });
    const candidate = (await transport.listCandidates()).candidates[0] ?? {
      id: "ssh:x",
      transport: "ssh" as const,
      name: "x",
      user: "u",
      host: "h",
      port: null,
      sshAlias: "x",
    };
    const id = await startMachineEnrollment(source, transport, candidate, "x");
    let latest: MachineEnrollmentSnapshot = { steps: [] };
    source.watch(id, (snapshot) => (latest = snapshot));
    await settle();
    expect(machineEnrollmentProgress(latest.steps)).toMatchObject({ key: "peer_connected" });
    online = true;
    tick.flush();
    expect(machineEnrollmentProgress(latest.steps).phase).toBe("green");
  });

  it("marks the running step failed; a rejected password says so", async () => {
    const { source, transport } = createLegacyMachineEnrollment({
      listSshHosts: async () => [],
      localName: null,
      isOnline: () => false,
      add: async (_request, phase) => {
        phase("transport_connected", "running");
        return { status: "error", message: "deck@h: Permission denied (password)." };
      },
    });
    const candidate = {
      id: "manual:ssh:h",
      transport: "ssh" as const,
      name: "h",
      user: "deck",
      host: "h",
      port: null,
      sshAlias: null,
    };
    const id = await startMachineEnrollment(source, transport, candidate, "h", "geheim-123");
    let latest: MachineEnrollmentSnapshot = { steps: [] };
    source.watch(id, (snapshot) => (latest = snapshot));
    await settle();
    const fault = machineEnrollmentProgress(latest.steps).fault;
    expect(fault).toMatchObject({ key: "transport_connected", error_code: "password_rejected" });
    // Das Passwort taucht in keinem Schritt, keiner Fehlerzeile und keinem Detail auf.
    expect(JSON.stringify(latest)).not.toContain("geheim-123");
    // Nach dem Lauf ist kein Anspruch und damit kein Passwort mehr im Speicher.
    expect(activeSshPasswordClaims()).toBe(0);
  });

  it("classifies raw messages", () => {
    expect(legacyErrorCode("transport_connected", "Permission denied (publickey).")).toBe(
      "auth_rejected",
    );
    expect(legacyErrorCode("transport_connected", "ssh: connect: Operation timed out")).toBe(
      "unreachable",
    );
    expect(legacyErrorCode("installed", "boom")).toBe("install_failed");
  });
});

describe("Einmal-Passwort", () => {
  it("answers only prompts for the claimed target and forgets the password on release", () => {
    const release = claimSshPassword({ hosts: ["100.64.0.28", "nas"], user: "admin" }, "pw-1");
    expect(claimedSshPassword({ destination: "admin@100.64.0.28", username: "admin" })).toBe(
      "pw-1",
    );
    expect(claimedSshPassword({ destination: "other@10.0.0.1", username: null })).toBeUndefined();
    release();
    expect(
      claimedSshPassword({ destination: "admin@100.64.0.28", username: "admin" }),
    ).toBeUndefined();
    expect(activeSshPasswordClaims()).toBe(0);
  });
});

describe("SSH sources over the desktop bridge (N6, real path)", () => {
  it("drops git hosts and CTOX fleet hosts from what discoverSshHosts returns", async () => {
    // Exactly what desktop:discover-ssh-hosts delivered on Welsch (16.10.).
    const { transport } = createLegacyMachineEnrollment({
      listSshHosts: async () => [
        host("github.com", "github.com", "michaelwelsch"),
        host("gh", "github.com", "git"),
        host("gitlab.com", "gitlab.com", "git"),
        host("ctox-fleet-rbx6", "217.182.134.181", "ubuntu"),
        host("lan-gpu3", "192.168.1.3", "metricspace"),
        host("ts-gpu4", "100.64.0.4", "metricspace"),
      ],
      localName: "Dieser Rechner",
      isOnline: () => false,
      add: async () => ({ status: "ok" as const }),
    });
    const sources = await transport.listCandidates();
    expect(sources.candidates.map((candidate) => candidate.id)).toEqual([
      "local",
      "ssh:lan-gpu3",
      "ssh:ts-gpu4",
    ]);
  });
});

describe("known computers in the add list (N6)", () => {
  it("hides computers that are already set up instead of marking them „Vorhanden“", async () => {
    const { visibleMachineCandidates } = await import("./AddMachineEnrollment");
    const candidates = legacyMachineCandidates({
      localName: "Dieser Rechner",
      sshHosts: [host("lan-gpu3", "192.168.1.3", "u"), host("ts-gpu4", "100.64.0.4", "u")],
      peers: null,
    });
    const visible = visibleMachineCandidates(
      candidates,
      "ssh",
      new Set(),
      (candidate) => candidate.sshAlias === "lan-gpu3",
    );
    expect(visible.map((candidate) => candidate.id)).toEqual(["ssh:ts-gpu4"]);
  });
});
