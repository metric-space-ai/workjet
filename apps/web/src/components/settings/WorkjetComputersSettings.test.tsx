import {
  DEFAULT_WORKJET_CONFIGURATION,
  EnvironmentId,
  WorkjetComputerId,
  type WorkjetComputer,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  applyAutomaticCurrentComputer,
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
