import {
  DEFAULT_WORKJET_CONFIGURATION,
  EnvironmentId,
  WorkjetComputerId,
  type WorkjetComputer,
  type WorkjetHarnessAvailabilitySnapshot,
} from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  applyAutomaticCurrentComputer,
  findComputerForTarget,
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

  it("offers the trash can, active switch and ⋯ menu on every row, without dialogs", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configurationWith(localComputer)}
        environments={[]}
        environmentsReady
        membership={membership}
        onChange={() => undefined}
        isActive={() => true}
        onActiveChange={() => undefined}
        onRemove={async () => null}
        onRecheck={() => undefined}
      />,
    );
    expect(markup).toContain("Weitere Aktionen für flashstore24-nas");
    expect(markup).toContain("Weitere Aktionen für computer-local");
    expect(markup).toContain('aria-label="flashstore24-nas entfernen"');
    expect(markup).toContain('aria-label="computer-local entfernen"');
    expect(markup.match(/role="switch"/g)).toHaveLength(2);
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
    expect(markup).toContain("Instanz nicht erreichbar");
  });

  it("keeps rows and their order while the instance re-checks (no layout jump)", () => {
    const rowsOf = (markup: string) =>
      [...markup.matchAll(/data-workjet-(?:native-)?computer="([^"]+)"/g)].map((m) => m[1]);
    const ready = render("ready");
    const loading = render("loading");
    expect(rowsOf(loading)).toEqual(rowsOf(ready));
    expect(rowsOf(loading)).toHaveLength(2);
    expect(loading).toContain('data-slot="computers-membership-checking"');
    expect(ready).not.toContain('data-slot="computers-membership-checking"');
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
    expect(markup).toContain('data-slot="computer-tools-checking"');
    expect(markup).not.toContain("local-version");
  });

  it("discards stale primary results when its new inspection fails", () => {
    const markup = renderInspection(localComputer, {
      [localEnvironmentId]: { snapshot: null, error: "Disconnected" },
    });
    expect(markup).toContain("Werkzeuge ?");
    expect(markup).not.toContain("local-version");
    expect(markup).not.toContain('data-slot="computer-tools-checking"');
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
    expect(markup).toContain('aria-label="Offline"');
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
    expect(markup).toContain('aria-label="Offline"');
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
    expect(markup).toContain('data-slot="computer-tools-checking"');
    expect(markup).not.toContain('aria-label="Offline"');
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
    expect(markup).toContain("verbindet…");
    expect(markup).not.toContain('aria-label="Offline"');
    expect(markup).not.toContain("Werkzeuge ?");
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
