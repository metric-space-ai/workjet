import {
  DEFAULT_WORKJET_CONFIGURATION,
  EnvironmentId,
  WorkjetComputerId,
  type ComputerMetadata,
  type WorkjetComputer,
} from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WORKJET_STATUS_DOT_CLASS } from "../../workjetStatus";
import {
  nextRemoteDaemonUpdates,
  remoteDaemonUpdateFor,
  type RemoteDaemonUpdates,
} from "./remoteDaemonUpdate";
import { WorkjetComputersSettingsView } from "./WorkjetComputersSettings";

const target = { alias: "ts-gpu3", hostname: "100.64.0.3", username: "metricspace", port: 22 };
const metadata: ComputerMetadata = {
  connection: { _tag: "ssh", target },
  facts: null,
  roles: { build: true, storage: false },
  active: true,
  hostKeyFingerprint: null,
  identityFiles: [],
  status: "ready",
  error: null,
  previousIds: [],
  legacyRecords: [],
};
const environmentId = EnvironmentId.make("environment-gpu3");
const gpu3: WorkjetComputer = {
  id: WorkjetComputerId.make("computer-gpu3"),
  label: "gpu3",
  environmentId,
  presentationKind: "ssh",
  harnesses: [],
  metadata,
};

const render = (updates: RemoteDaemonUpdates, onRetry?: () => void) =>
  renderToStaticMarkup(
    <WorkjetComputersSettingsView
      configuration={{ ...DEFAULT_WORKJET_CONFIGURATION, computers: [gpu3] }}
      environments={[{ environmentId, label: "gpu3", presentationKind: "ssh", detail: "SSH" }]}
      environmentsReady
      connectedEnvironmentIds={[environmentId]}
      // Settled row (tool probe answered with an error): the dot is not busy on its own.
      harnessInspections={{ [environmentId]: { snapshot: null, error: "probe failed" } }}
      onChange={() => undefined}
      onActiveChange={() => undefined}
      remoteDaemonUpdates={updates}
      {...(onRetry ? { onRetryRemoteDaemonUpdate: onRetry } : {})}
    />,
  );

describe("remote daemon update on the computer row", () => {
  it("tracks updating, clears on updated and keeps a failure until the next attempt", () => {
    const start: RemoteDaemonUpdates = new Map();
    const connecting = nextRemoteDaemonUpdates(start, { ...target, phase: "copying" });
    expect(connecting).toBe(start);
    const updating = nextRemoteDaemonUpdates(start, { ...target, phase: "updating" });
    expect(remoteDaemonUpdateFor(updating, metadata.connection)).toBe("updating");
    expect(
      remoteDaemonUpdateFor(
        nextRemoteDaemonUpdates(updating, { ...target, phase: "updated" }),
        metadata.connection,
      ),
    ).toBeNull();
    const failed = nextRemoteDaemonUpdates(updating, { ...target, phase: "update-failed" });
    expect(remoteDaemonUpdateFor(failed, metadata.connection)).toBe("failed");
    expect(remoteDaemonUpdateFor(failed, { _tag: "local" })).toBeNull();
  });

  it("shows the update only through the orange dot, without a sentence", () => {
    const idle = render(new Map());
    const updating = render(new Map([["ts-gpu3", "updating"]]));
    const waiting = WORKJET_STATUS_DOT_CLASS.waiting.split(" ")[0]!;
    expect(idle).not.toContain(waiting);
    expect(updating).toContain(waiting);
    expect(updating).not.toContain("Aktualisier");
    expect(idle).not.toContain("Aktualisier");
    expect(updating).not.toEqual(idle);
  });

  it("shows one failure line with „Erneut“", () => {
    const markup = render(new Map([["ts-gpu3", "failed"]]), () => undefined);
    expect(markup).toContain('data-slot="computer-update-failed"');
    expect(markup).toContain("Aktualisierung fehlgeschlagen");
    expect(markup.match(/>Erneut</g)).toHaveLength(1);
  });
});
