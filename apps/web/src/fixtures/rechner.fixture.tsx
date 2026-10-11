/**
 * Isolierte Fixture für Einstellungen › Rechner (Screenshots, kein Backend).
 * Der Desktop-Bridge-Ersatz beantwortet nur Host-Schlüssel, Preflight,
 * tailnet, SSH-Schlüssel und das Rechner-Backend mit festen Werten; nichts
 * verbindet sich irgendwohin.
 */
import {
  DEFAULT_WORKJET_CONFIGURATION,
  EnvironmentId,
  WorkjetComputerId,
  type ComputerFacts,
  type ComputerMetadata,
  type WorkjetComputer,
  type WorkjetConfiguration,
} from "@workjet/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { AddComputerInline, type AddComputerKind } from "../components/settings/AddComputerInline";
import { ComputerProvisioningSection } from "../components/settings/ComputerProvisioningSection";
import {
  knownComputerFacts,
  WorkjetComputersSettingsView,
} from "../components/settings/WorkjetComputersSettings";
import "../index.css";

const query = new URLSearchParams(window.location.search);
const delay = <T,>(value: T, ms = 400) =>
  new Promise<T>((resolve) => window.setTimeout(() => resolve(value), ms));

(window as unknown as { desktopBridge: unknown }).desktopBridge = {
  inspectProvisioningHostKey: () =>
    delay({
      _tag: "ready",
      algorithm: "ED25519",
      fingerprint: "SHA256:q3J8bV0m4Wc1xYzK7pLr2NfT9sHdE6uA5oGiQ+BkXvM",
    }),
  preflightProvisioningTarget: () =>
    delay(
      query.get("preflight") === "fail"
        ? { _tag: "failed", code: "preflight_failed", message: "sudo verlangt ein Passwort." }
        : {
            _tag: "ready",
            preflight: {
              preflightId: "fixture",
              expiresAt: "2026-10-11T23:00:00.000Z",
              target: { _tag: "local" },
              platform: "linux",
              architecture: "x64",
              internetAvailable: true,
              administratorCapable: true,
              administratorPasswordRequired: false,
              administratorElevationRequired: false,
              graphicalSession: false,
              ctoxInstalledVersion: "0.1.3",
              workjetInstalledVersion: null,
              warnings: [],
            },
          },
    ),
  startProvisioningOperation: () => delay({ _tag: "failed", message: "Fixture" }),
  getProvisioningOperation: () => delay({ _tag: "missing" }),
  listProvisioningOperations: () => delay({ _tag: "found", operations: [] }),
  listComputerSshKeys: () =>
    delay([
      { path: "/Users/michael/.ssh/id_ed25519", publicKeyFingerprint: "SHA256:7Hq2…ed25519" },
      { path: "/Users/michael/.ssh/gpu_deploy", publicKeyFingerprint: "SHA256:Lk9x…deploy" },
      { path: "/Users/michael/.ssh/id_rsa", publicKeyFingerprint: "SHA256:aa31…rsa" },
    ]),
  discoverTailscalePeers: () =>
    delay({
      status: "available",
      peers: [
        { id: "1", name: "gpu1-a6000", hostname: "100.87.204.48", online: true },
        { id: "2", name: "gpu3-a4500", hostname: "100.101.12.7", online: true },
        { id: "3", name: "gpu4", hostname: "100.120.16.93", online: true },
        { id: "4", name: "nas-asustor", hostname: "100.64.0.28", online: false },
      ],
    }),
};

const discoverTailscalePeers = () =>
  (
    window as unknown as {
      desktopBridge: { discoverTailscalePeers: () => Promise<never> };
    }
  ).desktopBridge.discoverTailscalePeers();

const local = EnvironmentId.make("env-local");
const gpu3Env = EnvironmentId.make("env-gpu3");
const gpu4Env = EnvironmentId.make("env-gpu4");
const vpsEnv = EnvironmentId.make("env-vps");

const GIB = 1024 ** 3;
const facts = (
  machineId: string,
  cpuCores: number,
  ramGib: number,
  gpus: ComputerFacts["gpus"],
): ComputerFacts => ({
  checkedAt: "2026-10-12T00:10:00.000Z",
  machineId,
  operatingSystem: "linux",
  architecture: "x86_64",
  cpuCores,
  ramBytes: ramGib * GIB,
  homeDirectory: "/home/metricspace",
  workDirectory: "/home/metricspace/.workjet/computer-work",
  freeBytes: 700 * GIB,
  gpus,
  toolchains: { rustc: "1.90.0", node: "24.3.0" },
  codingTools: {},
  warnings: [],
});
const metadata = (
  connection: ComputerMetadata["connection"],
  detected: ComputerFacts | null,
  overrides: Partial<ComputerMetadata> = {},
): ComputerMetadata => ({
  connection,
  facts: detected,
  roles: { build: true, storage: false },
  active: true,
  hostKeyFingerprint: null,
  identityFiles: [],
  status: "ready",
  error: null,
  previousIds: [],
  legacyRecords: [],
  ...overrides,
});
const ssh = (alias: string, hostname: string, username: string) => ({
  alias,
  hostname,
  username,
  port: 22,
});

const computer = (
  id: string,
  label: string,
  environmentId: EnvironmentId,
  kind: WorkjetComputer["presentationKind"],
  harnesses: WorkjetComputer["harnesses"],
  computerMetadata?: ComputerMetadata,
): WorkjetComputer => ({
  id: WorkjetComputerId.make(id),
  label,
  environmentId,
  presentationKind: kind,
  harnesses,
  ...(computerMetadata ? { metadata: computerMetadata } : {}),
});

const initial: WorkjetConfiguration = {
  ...DEFAULT_WORKJET_CONFIGURATION,
  computers: [
    computer(
      "computer-mac",
      "MacBook Pro",
      local,
      "local",
      [
        { harness: "claude-code", available: true },
        { harness: "codex-cli", available: true },
        { harness: "grok-cli", available: true },
        { harness: "opencode", available: true },
      ],
      metadata(
        { _tag: "local" },
        {
          ...facts("machine-mac", 14, 36, [
            { model: "Apple M3 Max", vramBytes: null, unifiedMemory: true },
          ]),
          operatingSystem: "darwin",
          architecture: "arm64",
        },
        { roles: { build: false, storage: false } },
      ),
    ),
    computer(
      "computer-gpu3",
      "gpu3-a4500",
      gpu3Env,
      "ssh",
      [
        { harness: "claude-code", available: true },
        { harness: "codex-cli", available: true },
      ],
      metadata(
        { _tag: "ssh", target: ssh("lan-gpu3", "192.168.1.30", "metricspace") },
        facts("machine-gpu3", 32, 128, [
          { model: "NVIDIA RTX A4500", vramBytes: 20 * GIB, unifiedMemory: false },
        ]),
        { identityFiles: ["/Users/michael/.ssh/gpu_deploy"] },
      ),
    ),
    computer(
      "computer-gpu4",
      "gpu4",
      gpu4Env,
      "tailscale",
      [{ harness: "codex-cli", available: true }],
      metadata(
        { _tag: "tailscale", target: ssh("gpu4", "100.120.16.93", "metricspace") },
        facts("machine-gpu4", 24, 64, [
          { model: "NVIDIA GeForce RTX 4090", vramBytes: 24 * GIB, unifiedMemory: false },
        ]),
        { roles: { build: true, storage: true } },
      ),
    ),
    computer(
      "computer-vps",
      "vps-hetzner",
      vpsEnv,
      "ssh",
      [],
      metadata(
        { _tag: "ssh", target: ssh("vps-hetzner", "49.12.0.10", "root") },
        facts("machine-vps", 4, 8, []),
        { active: false, roles: { build: false, storage: false } },
      ),
    ),
  ],
  selectedComputerId: WorkjetComputerId.make("computer-mac"),
};

const snapshot = (harnesses: ReadonlyArray<string>) => ({
  schemaVersion: 1 as const,
  probedAt: "2026-10-11T21:00:00.000Z",
  harnesses: harnesses.map((harness) => ({
    harness: harness as "codex-cli",
    availability: "available" as const,
    executablePath: `/usr/local/bin/${harness}`,
    version: "1.0.0",
  })),
});

function Fixture() {
  const [configuration, setConfiguration] = useState(initial);
  const [addOpen, setAddOpen] = useState(query.get("add") !== null);
  const [segment, setSegment] = useState<AddComputerKind>(
    (query.get("add") as AddComputerKind | null) ?? "ssh",
  );
  const membershipPhase = query.get("membership") === "loading" ? "loading" : "ready";
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex h-12 items-center gap-2 border-b border-border px-4 text-[13.5px]">
        <span className="font-semibold">Einstellungen</span>
        <span className="text-muted-foreground">/ Rechner</span>
      </div>
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-5">
        <WorkjetComputersSettingsView
          configuration={configuration}
          environments={[
            { environmentId: local, label: "Local", presentationKind: "local", detail: "Local" },
            {
              environmentId: gpu3Env,
              label: "lan-gpu3",
              presentationKind: "ssh",
              detail: "metricspace@192.168.1.30",
            },
            {
              environmentId: gpu4Env,
              label: "gpu4",
              presentationKind: "ssh",
              detail: "metricspace@100.120.16.93",
            },
            {
              environmentId: vpsEnv,
              label: "vps-hetzner",
              presentationKind: "ssh",
              detail: "root@49.12.0.10",
            },
          ]}
          environmentsReady
          environmentId={local}
          harnessInspections={{
            [local]: {
              snapshot: snapshot(["claude-code", "codex-cli", "grok-cli", "opencode"]),
              error: null,
            },
            [gpu3Env]: { snapshot: snapshot(["claude-code", "codex-cli"]), error: null },
          }}
          connectedEnvironmentIds={[local, gpu3Env, vpsEnv]}
          connectingEnvironmentIds={[]}
          onChange={setConfiguration}
          businessOsLabel="welsch"
          membership={{
            instanceId: "welsch",
            phase: membershipPhase,
            pendingComputerId: null,
            error: null,
            computers: [
              {
                id: "native-gpu3",
                displayName: "gpu3",
                detectedFacts: facts("machine-gpu3", 32, 128, []),
                hostingMode: "workstation",
                status: "assigned",
                capabilities: ["claude-code", "build", "gpu"],
                capabilityConfig: [
                  {
                    kind: "build",
                    ssh_endpoint_ref: "endpoint-gpu3",
                    slots: 1,
                    jobs: 32,
                    lane_root: "~/.workjet/build",
                    disk_floor_gib: 20,
                    toolchains: ["rust-stable"],
                  },
                  { kind: "gpu", model: "NVIDIA RTX A4500", vram_gib: 20 },
                ],
                selfHostedColocation: false,
              },
              {
                id: "native-nas",
                displayName: "flashstore24-nas",
                hostingMode: "self_hosted",
                status: "assigned",
                capabilities: ["storage"],
                agentless: true,
                selfHostedColocation: false,
              },
            ],
          }}
          capacities={Object.fromEntries(
            configuration.computers.map((entry) => [
              entry.id,
              entry.metadata?.facts
                ? {
                    concurrentBuilds: 1 as const,
                    workersPerBuild: entry.metadata.facts.cpuCores,
                    useGpu: entry.metadata.facts.gpus.length > 0,
                    directory: entry.metadata.facts.workDirectory,
                    enoughFreeSpace: true,
                  }
                : null,
            ]),
          )}
          onActiveChange={(row, active) =>
            setConfiguration((current) => ({
              ...current,
              computers: current.computers.map((entry) =>
                entry.id === row.computer?.id && entry.metadata
                  ? { ...entry, metadata: { ...entry.metadata, active } }
                  : entry,
              ),
            }))
          }
          onRemove={async (row, mode) => {
            await delay(null, 600);
            if (query.get("remove") === "fail" && mode === "workjet-and-files")
              return { tone: "error" as const, text: "1 Pfad nicht entfernt" };
            setConfiguration((current) => ({
              ...current,
              computers: current.computers.filter((entry) => entry.id !== row.computer?.id),
            }));
            return mode === "workjet-and-files"
              ? { tone: "ok" as const, text: "3 Pfade entfernt" }
              : { tone: "ok" as const, text: "Aus Workjet entfernt" };
          }}
          onRecheck={() => undefined}
          onRetryMembership={() => undefined}
          renderRepair={(row) => (
            <ComputerProvisioningSection
              initialKind={row.computer?.environmentId === local ? "local" : "ssh"}
              fixedTargetKind
              initialTarget={{ host: "100.120.16.93", username: "metricspace", port: 22 }}
            />
          )}
          addPanel={
            <AddComputerInline
              open={addOpen}
              onOpenChange={setAddOpen}
              segment={segment}
              onSegmentChange={setSegment}
              localAvailable
              desktopAvailable
              sshAliases={[
                {
                  alias: "lan-gpu1",
                  hostname: "192.168.1.21",
                  username: "deck",
                  port: 22,
                  source: "ssh-config",
                },
                {
                  alias: "lan-gpu3",
                  hostname: "192.168.1.30",
                  username: "metricspace",
                  port: 22,
                  source: "ssh-config",
                },
                {
                  alias: "welsch",
                  hostname: "welsch.ctox.dev",
                  username: "root",
                  port: 22,
                  source: "ssh-config",
                },
                {
                  alias: "skf-vm",
                  hostname: "10.20.0.4",
                  username: "ctox",
                  port: 2222,
                  source: "ssh-config",
                },
              ]}
              knownHosts={["100.87.204.48", "100.120.16.93"]}
              sshAliasesLoading={false}
              onRefreshSshAliases={() => undefined}
              rolesAvailable
              sshKeys={[
                { path: "/Users/michael/.ssh/id_ed25519", publicKeyFingerprint: "SHA256:7Hq2" },
                { path: "/Users/michael/.ssh/gpu_deploy", publicKeyFingerprint: "SHA256:Lk9x" },
                { path: "/Users/michael/.ssh/id_rsa", publicKeyFingerprint: "SHA256:aa31" },
              ]}
              knownComputer={(kind, hostname) =>
                knownComputerFacts(configuration.computers, kind, hostname, local)
              }
              discoverTailscalePeers={discoverTailscalePeers}
              inspectHostKey={() =>
                delay({
                  _tag: "ready" as const,
                  algorithm: "ED25519",
                  fingerprint: "SHA256:q3J8bV0m4Wc1xYzK7pLr2NfT9sHdE6uA5oGiQ+BkXvM",
                })
              }
              onAdd={async () =>
                query.get("result") === "error"
                  ? delay({ status: "error" as const, message: "Permission denied (publickey)." })
                  : delay({ status: "done" as const })
              }
            />
          }
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
