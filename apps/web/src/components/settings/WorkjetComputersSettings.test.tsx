import {
  DEFAULT_WORKJET_CONFIGURATION,
  EnvironmentId,
  WorkjetComputerId,
  type WorkjetComputer,
  type WorkjetHarnessAvailabilitySnapshot,
} from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  applyAutomaticCurrentComputer,
  includeSavedComputers,
  removeComputer,
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
    expect(markup).toContain("Reconnect Remote Linux");
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
});
