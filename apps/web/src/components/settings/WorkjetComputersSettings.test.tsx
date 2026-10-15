// @effect-diagnostics nodeBuiltinImport:off - Der Test liest die Quelldatei direkt.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  DEFAULT_WORKJET_CONFIGURATION,
  EnvironmentId,
  WorkjetComputerId,
  type ComputerControlInput,
  type ComputerControlResult,
  type ComputerFacts,
  type ComputerMetadata,
  type WorkjetComputer,
  type WorkjetHarnessAvailabilitySnapshot,
} from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  applyAutomaticCurrentComputer,
  changeComputerActive,
  computerConnectionFor,
  findComputerForTarget,
  knownComputerFacts,
  removeComputerRow,
  removedPathsSummary,
  withComputerRecords,
  includeSavedComputers,
  mergeComputerRows,
  removeComputer,
  removeComputerConnection,
  toggleCurrentComputer,
  WorkjetComputersSettingsView,
} from "./WorkjetComputersSettings";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

const computer = (id: string, environmentId: EnvironmentId): WorkjetComputer => ({
  id: WorkjetComputerId.make(id),
  label: id,
  environmentId,
  presentationKind: environmentId === localEnvironmentId ? "local" : "ssh",
  harnesses: [],
});

const localComputer = computer("computer-local", localEnvironmentId);
const remoteComputer = computer("computer-remote", remoteEnvironmentId);

const configurationWith = (...computers: ReadonlyArray<WorkjetComputer>) => ({
  ...DEFAULT_WORKJET_CONFIGURATION,
  computers,
});

const GIB = 1024 ** 3;
const gpuFacts: ComputerFacts = {
  checkedAt: "2026-10-12T00:00:00.000Z",
  machineId: "machine-gpu3",
  operatingSystem: "linux",
  architecture: "x86_64",
  cpuCores: 32,
  ramBytes: 128 * GIB,
  homeDirectory: "/home/metricspace",
  workDirectory: "/home/metricspace/.workjet/computer-work",
  freeBytes: 900 * GIB,
  gpus: [{ model: "NVIDIA RTX A4500", vramBytes: 20 * GIB, unifiedMemory: false }],
  toolchains: { rustc: "1.90.0" },
  codingTools: {},
  warnings: [],
};

function metadataWith(overrides: Partial<ComputerMetadata> = {}): ComputerMetadata {
  return {
    connection: {
      _tag: "ssh",
      target: { alias: "lan-gpu3", hostname: "192.168.1.30", username: "metricspace", port: 22 },
    },
    facts: null,
    roles: { build: true, storage: false },
    active: true,
    hostKeyFingerprint: null,
    identityFiles: [],
    status: "ready",
    error: null,
    previousIds: [],
    legacyRecords: [],
    ...overrides,
  };
}

function controlResult(
  computers: ReadonlyArray<WorkjetComputer>,
  removedPaths: ComputerControlResult["removedPaths"] = [],
): ComputerControlResult {
  return {
    computers: computers.map((entry) => ({
      id: entry.id,
      label: entry.label,
      environmentId: entry.environmentId,
      metadata: entry.metadata ?? metadataWith(),
      capacity: entry.metadata?.facts
        ? {
            concurrentBuilds: 1,
            workersPerBuild: entry.metadata.facts.cpuCores,
            useGpu: entry.metadata.facts.gpus.length > 0,
            directory: entry.metadata.facts.workDirectory,
            enoughFreeSpace: true,
          }
        : null,
    })),
    removedPaths,
  };
}

describe("removing local computer connections", () => {
  const membership = (phase: "ready" | "loading" | "failed", assigned = false) => ({
    instanceId: "selected-instance",
    phase,
    pendingComputerId: null,
    error: phase === "failed" ? "Business OS unavailable" : null,
    computers: assigned
      ? [
          {
            id: remoteComputer.id,
            displayName: remoteComputer.label,
            hostingMode: "workstation" as const,
            status: "assigned" as const,
            capabilities: [],
            selfHostedColocation: false,
          },
        ]
      : [],
  });
  const remove = (overrides: Partial<Parameters<typeof removeComputerConnection>[0]> = {}) =>
    removeComputerConnection({
      configuration: configurationWith(localComputer, remoteComputer),
      computer: remoteComputer,
      selectedInstanceId: "selected-instance",
      membership: membership("ready"),
      savedEnvironmentIds: [remoteEnvironmentId],
      removeConnection: async () => true,
      ...overrides,
    });

  it("removes an unreachable raw connection while retaining the other transport and current computer", async () => {
    const tailscaleComputer = computer(
      "computer-tailscale",
      EnvironmentId.make("environment-tailscale"),
    );
    const configuration = {
      ...configurationWith(localComputer, remoteComputer, tailscaleComputer),
      selectedComputerId: tailscaleComputer.id,
    };
    let finishRemoval!: (removed: boolean) => void;
    const removeConnection = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishRemoval = resolve;
        }),
    );
    let settled = false;
    const pending = remove({
      configuration,
      membership: membership("failed"),
      removeConnection,
    }).then((result) => {
      settled = true;
      return result;
    });
    expect(removeConnection).toHaveBeenCalledExactlyOnceWith(remoteEnvironmentId);
    expect(settled).toBe(false);
    expect(configuration.computers).toContain(remoteComputer);
    finishRemoval(true);
    expect(await pending).toEqual({
      status: "removed",
      configuration: {
        ...configuration,
        computers: [localComputer, tailscaleComputer],
        selectedComputerId: tailscaleComputer.id,
      },
    });
  });

  it.each(["ready", "loading", "failed"] as const)(
    "protects a known native assignment during %s inventory without removing its connection",
    async (phase) => {
      const removeConnection = vi.fn(async () => true);
      expect(await remove({ membership: membership(phase, true), removeConnection })).toEqual({
        status: "assigned",
      });
      expect(removeConnection).not.toHaveBeenCalled();
    },
  );

  it("keeps the computer and selection when removing its saved connection fails", async () => {
    const configuration = {
      ...configurationWith(localComputer, remoteComputer),
      selectedComputerId: remoteComputer.id,
    };
    const removeConnection = vi.fn(async () => false);
    expect(await remove({ configuration, removeConnection })).toEqual({
      status: "connection_failed",
    });
    expect(removeConnection).toHaveBeenCalledExactlyOnceWith(remoteEnvironmentId);
    expect(configuration.computers).toEqual([localComputer, remoteComputer]);
    expect(configuration.selectedComputerId).toBe(remoteComputer.id);
  });

  it("removes one configured row without deleting a connection still used by another row", async () => {
    const sharedComputer = computer("computer-shared", remoteEnvironmentId);
    const configuration = {
      ...configurationWith(localComputer, remoteComputer, sharedComputer),
      selectedComputerId: remoteComputer.id,
    };
    const removeConnection = vi.fn(async () => true);
    expect(await remove({ configuration, removeConnection })).toEqual({
      status: "removed",
      configuration: {
        ...configuration,
        computers: [localComputer, sharedComputer],
        selectedComputerId: null,
      },
    });
    expect(removeConnection).not.toHaveBeenCalled();
  });

  it("removes an unsaved connection without attempting transport deletion", async () => {
    const removeConnection = vi.fn(async () => true);
    const result = await remove({ savedEnvironmentIds: [], membership: null, removeConnection });
    expect(result.status).toBe("removed");
    expect(removeConnection).not.toHaveBeenCalled();
  });
});

describe("native computer capabilities", () => {
  const membership = {
    instanceId: "selected-instance",
    phase: "ready" as const,
    pendingComputerId: null,
    error: null,
    computers: [
      {
        id: "nas-native",
        displayName: "flashstore24-nas",
        hostingMode: "self_hosted" as const,
        status: "assigned" as const,
        capabilities: ["storage"],
        selfHostedColocation: false,
      },
      {
        id: localComputer.id,
        displayName: localComputer.label,
        hostingMode: "workstation" as const,
        status: "assigned" as const,
        capabilities: ["build", "gpu"],
        selfHostedColocation: false,
      },
    ],
  };
  const render = (phase: "ready" | "loading" | "failed") =>
    renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configurationWith(localComputer)}
        environments={[]}
        environmentsReady
        membership={{ ...membership, phase }}
        onChange={() => undefined}
      />,
    );

  it("shows a native NAS without creating a Code connection or selectable worker target", () => {
    const markup = render("ready");
    expect(markup).toContain("flashstore24-nas");
    expect(markup).toContain('data-workjet-capability="storage"');
    expect(markup).toContain('data-workjet-capability="build"');
    expect(markup).toContain('data-workjet-capability="gpu"');
    expect(markup).not.toContain("Use flashstore24-nas as current computer");
    expect(markup.match(/data-workjet-native-computer=/g)).toHaveLength(1);
  });

  it("offers the trash can and ⋯ menu on every row and the active switch on each Workjet computer, without dialogs", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configurationWith({
          ...localComputer,
          metadata: metadataWith({ connection: { _tag: "local" } }),
        })}
        environments={[]}
        environmentsReady
        membership={membership}
        onChange={() => undefined}
        onActiveChange={() => undefined}
        onRemove={async () => ({ tone: "ok", text: "Aus Workjet entfernt" })}
        onRecheck={() => undefined}
      />,
    );
    expect(markup).toContain("Weitere Aktionen für flashstore24-nas");
    expect(markup).toContain("Weitere Aktionen für computer-local");
    // Entfernen liegt im ⋯-Menü (Bestätigung inline), kein Papierkorb in der Zeile.
    expect(markup).not.toContain('aria-label="flashstore24-nas entfernen"');
    expect(markup).not.toContain('aria-label="computer-local entfernen"');
    // Jede Zeile hat denselben Schalter; der Instanz-Eintrag ohne Workjet-Datensatz
    // zeigt ihn gesperrt.
    expect(markup.match(/role="switch"/g)).toHaveLength(2);
    expect(markup).toMatch(
      /aria-label="flashstore24-nas aktiv"[^>]*disabled|disabled[^>]*aria-label="flashstore24-nas aktiv"/,
    );
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('role="alertdialog"');
  });

  it("does not describe an unassigned native host as assigned", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configurationWith(localComputer)}
        environments={[]}
        environmentsReady
        membership={{
          ...membership,
          computers: membership.computers.map((computer) => ({
            ...computer,
            status: "unassigned",
          })),
        }}
        onChange={() => undefined}
      />,
    );
    expect(markup).not.toContain("flashstore24-nas");
    expect(markup).not.toContain("data-workjet-capability=");
  });

  it("does not claim native capabilities from failed inventory", () => {
    const markup = render("failed");
    expect(markup).not.toContain("flashstore24-nas");
    expect(markup).not.toContain("data-workjet-capability=");
    expect(markup).toContain("Rechnerliste nicht abrufbar");
  });

  it("keeps rows and their order while the instance re-checks (no layout jump)", () => {
    const rowsOf = (markup: string) =>
      [...markup.matchAll(/data-workjet-(?:native-)?computer="([^"]+)"/g)].map((m) => m[1]);
    const ready = render("ready");
    const loading = render("loading");
    expect(rowsOf(loading)).toEqual(rowsOf(ready));
    expect(rowsOf(loading)).toHaveLength(2);
    // Kein „prüft…“ im Kopf: die Zeilen behalten ihren Stand.
    expect(loading).not.toContain("prüft…");
    expect(loading).not.toContain('data-slot="computers-membership-checking"');
  });
});

describe("current computer settings", () => {
  const inspection = (version: string): WorkjetHarnessAvailabilitySnapshot => ({
    schemaVersion: 1,
    probedAt: "2026-09-08T20:00:00.000Z",
    harnesses: [
      {
        harness: "codex-cli",
        availability: "available",
        executablePath: "/usr/bin/codex",
        version,
      },
    ],
  });

  const renderInspection = (
    target: WorkjetComputer,
    inspections: NonNullable<
      Parameters<typeof WorkjetComputersSettingsView>[0]["harnessInspections"]
    >,
  ) =>
    renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configurationWith({
          ...target,
          harnesses: [{ harness: "codex-cli", available: true }],
        })}
        environments={[
          {
            environmentId: remoteEnvironmentId,
            label: "Remote Linux",
            presentationKind: "ssh",
            detail: "SSH",
          },
        ]}
        environmentsReady
        environmentId={localEnvironmentId}
        harnessInspection={inspection("local-version")}
        harnessInspections={inspections}
        onChange={() => undefined}
      />,
    );

  it("shows the SSH computer's own tool version without calling it this machine", () => {
    const markup = renderInspection(remoteComputer, {
      [remoteEnvironmentId]: { snapshot: inspection("remote-version"), error: null },
    });
    expect(markup).toContain("remote-version");
    expect(markup).toContain("Remote Linux");
    expect(markup).not.toContain("local-version");
    expect(markup).not.toContain("Dieser Rechner");
  });

  it("shows progress instead of borrowing the primary computer's tool results", () => {
    const markup = renderInspection(remoteComputer, {});
    // Der Punkt zeigt die laufende Prüfung, kein Zustandstext.
    expect(markup).toContain('aria-label="Prüft"');
    expect(markup).not.toContain("prüft…");
    expect(markup).not.toContain("local-version");
  });

  it("discards stale primary results when its new inspection fails", () => {
    const markup = renderInspection(localComputer, {
      [localEnvironmentId]: { snapshot: null, error: "Disconnected" },
    });
    expect(markup).toContain('aria-label="Werkzeuge nicht prüfbar"');
    expect(markup).not.toContain("Werkzeuge ?");
    expect(markup).not.toContain("local-version");
    expect(markup).not.toContain('aria-label="Prüft"');
  });

  it("selects the local computer among three registered computers", () => {
    const secondRemoteComputer = computer("computer-remote-2", remoteEnvironmentId);

    expect(
      applyAutomaticCurrentComputer(
        configurationWith(remoteComputer, localComputer, secondRemoteComputer),
        localEnvironmentId,
      ).selectedComputerId,
    ).toBe(localComputer.id);
  });

  it("keeps the single-computer fallback when no local computer is registered", () => {
    expect(
      applyAutomaticCurrentComputer(configurationWith(remoteComputer), localEnvironmentId)
        .selectedComputerId,
    ).toBe(remoteComputer.id);
  });

  it("leaves multiple non-local computers unselected", () => {
    const secondRemoteComputer = computer("computer-remote-2", remoteEnvironmentId);

    expect(
      applyAutomaticCurrentComputer(
        configurationWith(remoteComputer, secondRemoteComputer),
        localEnvironmentId,
      ).selectedComputerId,
    ).toBeNull();
  });

  it("hides cached remote versions after its connection is removed", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configurationWith({
          ...remoteComputer,
          harnesses: [{ harness: "codex-cli", available: true }],
        })}
        environments={[]}
        environmentsReady
        environmentId={localEnvironmentId}
        harnessInspections={{
          [remoteEnvironmentId]: { snapshot: inspection("stale-remote"), error: null },
        }}
        onChange={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="Getrennt"');
    expect(markup).not.toContain("stale-remote");
  });

  it("preserves an existing current-computer selection", () => {
    const selectedRemote = {
      ...configurationWith(remoteComputer, localComputer),
      selectedComputerId: remoteComputer.id,
    };

    expect(applyAutomaticCurrentComputer(selectedRemote, localEnvironmentId)).toBe(selectedRemote);
  });

  it("uses radio semantics to select exactly one computer and deactivate it", () => {
    const selectedLocal = toggleCurrentComputer(
      configurationWith(localComputer, remoteComputer),
      localComputer.id,
    );
    expect(selectedLocal.selectedComputerId).toBe(localComputer.id);

    const selectedRemote = toggleCurrentComputer(selectedLocal, remoteComputer.id);
    expect(selectedRemote.selectedComputerId).toBe(remoteComputer.id);

    expect(toggleCurrentComputer(selectedRemote, remoteComputer.id).selectedComputerId).toBeNull();
  });

  it("clears the selection when the selected computer is deleted", () => {
    const selected = {
      ...configurationWith(localComputer, remoteComputer),
      selectedComputerId: localComputer.id,
    };
    const removed = removeComputer(selected, localComputer.id);

    expect(removed.computers).toEqual([remoteComputer]);
    expect(removed.selectedComputerId).toBeNull();
  });

  it("marks exactly one current computer without a radio column", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={{
          ...configurationWith(localComputer, remoteComputer),
          selectedComputerId: localComputer.id,
        }}
        environments={[
          {
            environmentId: localEnvironmentId,
            label: "Local",
            presentationKind: "local",
            detail: "Local",
          },
          {
            environmentId: remoteEnvironmentId,
            label: "Remote",
            presentationKind: "ssh",
            detail: "SSH",
          },
        ]}
        environmentsReady
        environmentId={localEnvironmentId}
        onChange={() => undefined}
      />,
    );

    expect(markup.match(/data-slot="computer-current"/g)).toHaveLength(1);
    expect(markup).not.toContain('role="radio"');
  });
});

describe("unified computer catalog", () => {
  const remote = {
    environmentId: remoteEnvironmentId,
    label: "Remote Linux",
    presentationKind: "ssh" as const,
    detail: "SSH",
  };

  it("reuses a configured computer reached through another connection", () => {
    const alias = {
      ...remote,
      environmentId: EnvironmentId.make("environment-relay"),
      hostId: "same-host",
    };
    const targets = [{ ...remote, hostId: "same-host" }, alias];
    const original = {
      ...configurationWith(remoteComputer),
      selectedComputerId: remoteComputer.id,
    };
    expect(findComputerForTarget(original, alias, targets)).toBe(remoteComputer);
    expect(includeSavedComputers(original, targets, localEnvironmentId)).toBe(original);
  });

  it("shows one row when two saved connections first reveal the same host", () => {
    const targets = [
      { ...remote, hostId: "same-host" },
      { ...remote, environmentId: EnvironmentId.make("environment-relay"), hostId: "same-host" },
    ];
    const merged = includeSavedComputers(configurationWith(), targets, localEnvironmentId);
    expect(merged.computers).toHaveLength(1);
    expect(merged.computers[0]?.environmentId).toBe(remoteEnvironmentId);
    expect(includeSavedComputers(merged, targets, localEnvironmentId)).toBe(merged);
  });

  it("does not create a remote row for another connection to the primary host", () => {
    const targets = [
      { ...remote, environmentId: localEnvironmentId, hostId: "local-host" },
      { ...remote, hostId: "local-host" },
    ];
    const original = configurationWith(localComputer);
    expect(includeSavedComputers(original, targets, localEnvironmentId)).toBe(original);
  });

  it("never merges equal labels, different hosts or missing host IDs", () => {
    for (const hostId of [undefined, "", "different-host"]) {
      const targets = [
        { ...remote, hostId: "known-host" },
        {
          ...remote,
          environmentId: EnvironmentId.make("another-environment"),
          ...(hostId === undefined ? {} : { hostId }),
        },
      ];
      const merged = includeSavedComputers(
        configurationWith(remoteComputer),
        targets,
        localEnvironmentId,
      );
      expect(merged.computers).toHaveLength(2);
      expect(merged.computers[0]).toBe(remoteComputer);
    }
  });

  it("keeps exact environment matches and existing configured rows intact", () => {
    const aliasComputer = computer("configured-alias", EnvironmentId.make("environment-relay"));
    const targets = [
      { ...remote, hostId: "same-host" },
      {
        ...remote,
        environmentId: aliasComputer.environmentId,
        hostId: "same-host",
      },
    ];
    const original = configurationWith(remoteComputer, aliasComputer);
    expect(findComputerForTarget(original, targets[1]!, targets)).toBe(aliasComputer);
    expect(includeSavedComputers(original, targets, localEnvironmentId)).toBe(original);
  });
  it("retains saved connections without creating a second record or changing selection", () => {
    const original = { ...configurationWith(localComputer), selectedComputerId: localComputer.id };
    const merged = includeSavedComputers(original, [remote], localEnvironmentId);
    expect(merged.computers).toHaveLength(2);
    expect(merged.computers[1]?.environmentId).toBe(remoteEnvironmentId);
    expect(merged.selectedComputerId).toBe(localComputer.id);
    expect(includeSavedComputers(merged, [remote], localEnvironmentId)).toBe(merged);
    expect(includeSavedComputers(original, [remote], localEnvironmentId).computers[1]?.id).toBe(
      merged.computers[1]?.id,
    );
  });
  it("preserves configured labels, tools and missing connections", () => {
    const original = configurationWith({
      ...remoteComputer,
      label: "GPU worker",
      harnesses: [{ harness: "codex-cli", available: true }],
    });
    expect(includeSavedComputers(original, [remote], localEnvironmentId)).toBe(original);
    expect(includeSavedComputers(original, [], localEnvironmentId)).toBe(original);
  });
  it("places repair inside the row menu and renders the add panel once", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configurationWith(remoteComputer)}
        environments={[remote]}
        environmentsReady
        environmentId={localEnvironmentId}
        onChange={() => undefined}
        addPanel={<button type="button">Rechner hinzufügen</button>}
        renderRepair={() => <button type="button">Reparatur Remote Linux</button>}
      />,
    );
    expect(markup).toContain("Weitere Aktionen für computer-remote");
    expect(markup).not.toContain("Reparatur Remote Linux");
    expect(markup.match(/>Rechner hinzufügen</g)).toHaveLength(1);
    expect(markup).not.toContain("Advanced setup and repair");
    expect(markup).not.toContain("Install on a computer");
  });
  it("recognizes a saved but disconnected computer and discards its stale probe", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configurationWith(remoteComputer)}
        environments={[remote]}
        environmentsReady
        connectedEnvironmentIds={[]}
        environmentId={localEnvironmentId}
        onChange={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="Getrennt"');
  });
  it("shows a pending connection as checking until its environment is ready", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configurationWith(remoteComputer)}
        environments={[remote]}
        environmentsReady
        connectedEnvironmentIds={[]}
        pendingConnectionEnvironmentId={remoteEnvironmentId}
        harnessInspections={{}}
        environmentId={localEnvironmentId}
        onChange={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="Prüft"');
    expect(markup).not.toContain("prüft…");
    expect(markup).not.toContain('aria-label="Getrennt"');
  });
  it("shows a connecting computer as connecting and ignores its stale probe error", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configurationWith(remoteComputer)}
        environments={[remote]}
        environmentsReady
        connectedEnvironmentIds={[]}
        connectingEnvironmentIds={[remoteEnvironmentId]}
        harnessInspections={{
          [remoteEnvironmentId]: { snapshot: null, error: "stale connection error" },
        }}
        environmentId={localEnvironmentId}
        onChange={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="Verbindet"');
    expect(markup).not.toContain("verbindet…");
    expect(markup).not.toContain('aria-label="Getrennt"');
    expect(markup).not.toContain('aria-label="Werkzeuge nicht prüfbar"');
  });
});

describe("one machine = one row", () => {
  const native = (id: string, displayName: string) => ({
    id,
    displayName,
    hostingMode: "workstation" as const,
    status: "assigned" as const,
    capabilities: ["build"],
    selfHostedColocation: false,
  });
  const gpu3 = { ...computer("computer-gpu3", remoteEnvironmentId), label: "gpu3-a4500" };

  it("merges the instance entry gpu3 with the SSH connection gpu3-a4500", () => {
    const rows = mergeComputerRows(
      [gpu3],
      [native("native-gpu3", "gpu3")],
      [
        {
          environmentId: remoteEnvironmentId,
          label: "lan-gpu3",
          presentationKind: "ssh",
          detail: "ssh://lan-gpu3",
        },
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.computer?.id).toBe("computer-gpu3");
    expect(rows[0]?.native?.id).toBe("native-gpu3");
  });

  it("merges by shared id first", () => {
    const rows = mergeComputerRows([localComputer], [native(localComputer.id, "anything")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.native?.displayName).toBe("anything");
  });

  it("never merges an ambiguous or unrelated name", () => {
    const gpu3b = { ...computer("computer-gpu3-b", localEnvironmentId), label: "gpu3-backup" };
    expect(mergeComputerRows([gpu3, gpu3b], [native("native-gpu3", "gpu3")])).toHaveLength(3);
    expect(mergeComputerRows([gpu3], [native("native-gpu1", "gpu1")])).toHaveLength(2);
  });

  it("renders exactly one row for the merged machine", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configurationWith(gpu3)}
        environments={[]}
        environmentsReady
        membership={{
          instanceId: "selected-instance",
          phase: "ready",
          pendingComputerId: null,
          error: null,
          computers: [native("native-gpu3", "gpu3")],
        }}
        onChange={() => undefined}
      />,
    );
    expect(markup.match(/data-workjet-(?:native-)?computer=/g)).toHaveLength(1);
    expect(markup).toContain('data-workjet-capability="build"');
  });
});

describe("Rechner-Backend (erkennen statt fragen)", () => {
  const gpu3: WorkjetComputer = {
    ...computer("computer-gpu3", remoteEnvironmentId),
    label: "gpu3-a4500",
    metadata: metadataWith({ facts: gpuFacts }),
  };
  const row = { key: gpu3.id, computer: gpu3, native: null };
  const viewOf = (configuration: ReturnType<typeof configurationWith>) =>
    renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configuration}
        environments={[]}
        environmentsReady
        onChange={() => undefined}
        onActiveChange={() => undefined}
        onRemove={async () => ({ tone: "ok", text: "" })}
      />,
    );

  it("persists the active switch through setActive and greys the inactive row", async () => {
    const control = vi.fn(async (input: ComputerControlInput) => {
      expect(input).toEqual({ _tag: "setActive", id: "computer-gpu3", active: false });
      return controlResult([{ ...gpu3, metadata: { ...gpu3.metadata!, active: false } }]);
    });
    const result = await changeComputerActive({ control, row, active: false });
    expect(control).toHaveBeenCalledTimes(1);
    const markup = viewOf(withComputerRecords(configurationWith(gpu3), result!.computers));
    expect(markup).toContain('data-active="false"');
    expect(markup).toContain("opacity-55");
    expect(markup).toMatch(
      /role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/,
    );
    expect(await changeComputerActive({ control: undefined, row, active: true })).toBeNull();
  });

  it("keeps no client-side active overlay", () => {
    const source = NodeFS.readFileSync(
      NodePath.join(
        NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
        "WorkjetComputersSettings.tsx",
      ),
      "utf8",
    );
    expect(source).not.toContain("workjet.computers.inactive");
    expect(source).not.toContain("localStorage");
  });

  it("shows the switch state of a pending toggle before the backend answers", () => {
    const markup = viewOf(withComputerRecords(configurationWith(gpu3), [], { [gpu3.id]: false }));
    expect(markup).toContain('data-active="false"');
  });

  it("removes only from Workjet with mode workjet-only", async () => {
    const control = vi.fn(async (_input: ComputerControlInput) => controlResult([]));
    const removeConnection = vi.fn(async () => null);
    const outcome = await removeComputerRow({
      row,
      mode: "workjet-only",
      control,
      unassign: null,
      removeConnection,
      removeWithoutBackend: async () => "nie",
    });
    expect(control).toHaveBeenCalledWith({
      _tag: "remove",
      id: "computer-gpu3",
      mode: "workjet-only",
    });
    expect(removeConnection).toHaveBeenCalledWith(gpu3);
    expect(outcome).toEqual({ tone: "ok", text: "Aus Workjet entfernt" });
  });

  it("removes the files too with mode workjet-and-files and reports the paths in one line", async () => {
    const control = vi.fn(async (_input: ComputerControlInput) =>
      controlResult(
        [],
        [
          { path: "/home/m/.workjet/computer-work/runtime", status: "removed" },
          { path: "/home/m/.workjet/computer-work/worktrees", status: "removed" },
          { path: "/home/m/.workjet/computer-work/caches", status: "removed" },
        ],
      ),
    );
    const outcome = await removeComputerRow({
      row,
      mode: "workjet-and-files",
      control,
      unassign: null,
      removeConnection: async () => null,
      removeWithoutBackend: async () => "nie",
    });
    expect(control).toHaveBeenCalledWith({
      _tag: "remove",
      id: "computer-gpu3",
      mode: "workjet-and-files",
    });
    expect(outcome).toEqual({ tone: "ok", text: "3 Pfade entfernt" });
  });

  it("keeps the connection when a path could not be removed", async () => {
    const removeConnection = vi.fn(async () => null);
    const outcome = await removeComputerRow({
      row,
      mode: "workjet-and-files",
      control: async () =>
        controlResult(
          [{ ...gpu3, metadata: { ...gpu3.metadata!, active: false } }],
          [
            { path: "/a/runtime", status: "removed" },
            { path: "/a/worktrees", status: "refused" },
            { path: "/a/caches", status: "absent" },
          ],
        ),
      unassign: null,
      removeConnection,
      removeWithoutBackend: async () => "nie",
    });
    expect(outcome).toEqual({ tone: "error", text: "1 Pfad nicht entfernt" });
    expect(removeConnection).not.toHaveBeenCalled();
    expect(removedPathsSummary([])).toEqual({ tone: "ok", text: "0 Pfade entfernt" });
  });

  it("shows detected GPU with VRAM, CPU count and derived build capacity as chips", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configurationWith(gpu3)}
        environments={[]}
        environmentsReady
        onChange={() => undefined}
        capacities={{ [gpu3.id]: controlResult([gpu3]).computers[0]!.capacity }}
      />,
    );
    expect(markup).toContain("GPU A4500 · 20 GB");
    expect(markup).toContain("32 CPUs");
    expect(markup).toContain('title="1 Build · 32 Jobs"');
    expect(markup).not.toMatch(/<input[^>]*(jobs|slots)/i);
  });

  it("matches the instance entry by machine id instead of by name", () => {
    const native = {
      id: "native-anything",
      displayName: "rack-07",
      hostingMode: "workstation" as const,
      status: "assigned" as const,
      capabilities: ["build"],
      detectedFacts: gpuFacts,
      selfHostedColocation: false,
    };
    expect(mergeComputerRows([gpu3], [native])).toHaveLength(1);
    // Gleicher Name, aber andere Maschine: nie zusammenführen.
    const other = {
      ...native,
      displayName: "gpu3",
      detectedFacts: { ...gpuFacts, machineId: "machine-other" },
    };
    expect(mergeComputerRows([gpu3], [other])).toHaveLength(2);
    // Frühere ID des zusammengeführten Rechners.
    const merged = { ...gpu3, metadata: { ...gpu3.metadata!, previousIds: ["env-old"] } };
    expect(
      mergeComputerRows(
        [merged],
        [{ ...native, id: "env-old", detectedFacts: undefined } as never],
      ),
    ).toHaveLength(1);
  });

  it("builds the backend connection and finds known facts for the add panel", () => {
    expect(
      computerConnectionFor({
        kind: "tailscale",
        target: { alias: "gpu4", hostname: "100.120.16.93", username: null, port: null },
        label: "",
        roles: { build: true, storage: false, gpu: false },
        hostKey: null,
        identityFile: null,
        gpuDecided: false,
      }),
    ).toEqual({
      _tag: "tailscale",
      target: { alias: "gpu4", hostname: "100.120.16.93", username: null, port: null },
    });
    expect(knownComputerFacts([gpu3], "ssh", "192.168.1.30", null)?.facts?.cpuCores).toBe(32);
    expect(knownComputerFacts([gpu3], "ssh", "lan-gpu3", null)?.facts?.gpus).toHaveLength(1);
    expect(knownComputerFacts([gpu3], "local", null, null)).toBeNull();
  });
});
