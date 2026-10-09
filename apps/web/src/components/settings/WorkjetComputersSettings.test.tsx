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

  it("offers removal for native-only storage and capability editing for a coding computer", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configurationWith(localComputer)}
        environments={[]}
        environmentsReady
        membership={membership}
        onChange={() => undefined}
        onUnassignNative={() => undefined}
        onCapabilities={() => undefined}
      />,
    );
    expect(markup).toContain("More actions for flashstore24-nas");
    expect(markup).not.toContain(">Remove from Business OS<");
    expect(markup).toContain("Edit capabilities for computer-local");
    expect(markup).not.toContain("Use flashstore24-nas as current computer");
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

  it("does not claim native capabilities from stale or failed inventory", () => {
    for (const phase of ["loading", "failed"] as const) {
      const markup = render(phase);
      expect(markup).not.toContain("flashstore24-nas");
      expect(markup).not.toContain("data-workjet-capability=");
    }
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
    expect(markup).not.toContain("This machine");
  });

  it("shows progress instead of borrowing the primary computer's tool results", () => {
    const markup = renderInspection(remoteComputer, {});
    expect(markup).toContain("Checking coding tools");
    expect(markup).not.toContain("local-version");
  });

  it("discards stale primary results when its new inspection fails", () => {
    const markup = renderInspection(localComputer, {
      [localEnvironmentId]: { snapshot: null, error: "Disconnected" },
    });
    expect(markup).toContain("Could not check coding tools");
    expect(markup).not.toContain("local-version");
    expect(markup).not.toContain("Checking coding tools");
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
    expect(markup).toContain("Disconnected. Reconnect this computer");
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

  it("renders one visible radio control and current marker per computer", () => {
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

    expect(markup.match(/role="radio"/g)).toHaveLength(2);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(markup).toContain("Current computer");
    expect(markup).toContain("Use as current computer");
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
  it("places connection actions beside their computer and provides one add entry", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputersSettingsView
        configuration={configurationWith(remoteComputer)}
        environments={[remote]}
        environmentsReady
        environmentId={localEnvironmentId}
        onChange={() => undefined}
        onAdd={() => undefined}
        renderConnection={() => <button>Reconnect Remote Linux</button>}
      />,
    );
    expect(markup).toContain("More actions for computer-remote");
    expect(markup).not.toContain("Reconnect Remote Linux");
    expect(markup.match(/>Add computer</g)).toHaveLength(1);
    expect(markup).not.toContain("Add existing connection");
    expect(markup).not.toContain("Remote environments");
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
    expect(markup).toContain("Disconnected. Reconnect this computer");
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
    expect(markup).toContain("Checking coding tools");
    expect(markup).not.toContain("Disconnected. Reconnect this computer");
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
    expect(markup).toContain("Connecting. Coding tools will be checked once connected.");
    expect(markup).not.toContain("Disconnected. Reconnect this computer");
    expect(markup).not.toContain("Could not check coding tools");
  });
});
