import { EnvironmentId, WorkjetComputerId, type WorkjetComputer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveComposerComputer } from "./ChatComposer";

const envA = EnvironmentId.make("environment-a");
const envB = EnvironmentId.make("environment-b");
const envC = EnvironmentId.make("environment-c");

const computer = (id: string, environmentId: EnvironmentId): WorkjetComputer => ({
  id: WorkjetComputerId.make(id),
  label: id,
  environmentId,
  presentationKind: "local",
  harnesses: [],
});

const workerComputer = computer("computer-worker", envB);
const environmentComputer = computer("computer-environment", envA);
const selectedComputer = computer("computer-selected", envC);
const computers = [environmentComputer, workerComputer, selectedComputer];

describe("composer computer resolution", () => {
  it("prefers a worker binding over the active environment and persisted selection", () => {
    expect(
      resolveComposerComputer({
        computers,
        workerModeActive: true,
        workerComputerId: workerComputer.id,
        activeEnvironmentId: envA,
        selectedComputerId: selectedComputer.id,
      }),
    ).toEqual({ computer: workerComputer, source: "worker" });
  });

  it("prefers the active environment over the persisted selection", () => {
    expect(
      resolveComposerComputer({
        computers,
        workerModeActive: false,
        workerComputerId: null,
        activeEnvironmentId: envA,
        selectedComputerId: selectedComputer.id,
      }),
    ).toEqual({ computer: environmentComputer, source: "environment" });
  });

  it("falls back to an existing persisted selection", () => {
    expect(
      resolveComposerComputer({
        computers,
        workerModeActive: false,
        workerComputerId: null,
        activeEnvironmentId: EnvironmentId.make("environment-without-computer"),
        selectedComputerId: selectedComputer.id,
      }),
    ).toEqual({ computer: selectedComputer, source: "selected" });
  });

  it("falls through missing worker and selected references deterministically", () => {
    expect(
      resolveComposerComputer({
        computers,
        workerModeActive: true,
        workerComputerId: "computer-missing",
        activeEnvironmentId: envA,
        selectedComputerId: "computer-also-missing",
      }),
    ).toEqual({ computer: environmentComputer, source: "environment" });

    expect(
      resolveComposerComputer({
        computers,
        workerModeActive: false,
        workerComputerId: null,
        activeEnvironmentId: EnvironmentId.make("environment-without-computer"),
        selectedComputerId: "computer-missing",
      }),
    ).toEqual({ computer: null, source: null });
  });
});
