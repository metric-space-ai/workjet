import { BusinessOsInstanceId, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { BusinessOsCodeScopeSnapshot } from "../../businessOsCodeScope";
import type { EnvironmentPresentation } from "../../state/environments";
import { resolveActiveBusinessOsSettingsEnvironment } from "./businessOsSettingsScope";

const readyScope: BusinessOsCodeScopeSnapshot = {
  phase: "ready",
  presentationInstanceId: "managed:welsch",
  businessOsInstanceId: BusinessOsInstanceId.make("welsch"),
  environmentIds: new Set([EnvironmentId.make("mac")]),
  blocker: null,
};

function environment(id: string, label: string): EnvironmentPresentation {
  return {
    environmentId: EnvironmentId.make(id),
    label,
  } as EnvironmentPresentation;
}

describe("active Business OS settings environment", () => {
  it("uses the one server authorized by the active instance", () => {
    const mac = environment("mac", "MacBook");
    expect(
      resolveActiveBusinessOsSettingsEnvironment({
        scope: readyScope,
        environments: [mac],
        inventoryReady: true,
      }),
    ).toEqual({ phase: "ready", environment: mac, reason: null });
  });

  it("never falls back to a previous or primary server while resolving", () => {
    expect(
      resolveActiveBusinessOsSettingsEnvironment({
        scope: {
          phase: "resolving",
          presentationInstanceId: "managed:other",
          businessOsInstanceId: null,
          environmentIds: new Set(),
          blocker: null,
        },
        environments: [environment("old-primary", "Old primary")],
        inventoryReady: true,
      }),
    ).toEqual({ phase: "resolving", environment: null, reason: null });
  });

  it("blocks zero and ambiguous environment ownership", () => {
    expect(
      resolveActiveBusinessOsSettingsEnvironment({
        scope: readyScope,
        environments: [],
        inventoryReady: true,
      }),
    ).toMatchObject({ phase: "blocked", reason: "no-code-computer" });
    expect(
      resolveActiveBusinessOsSettingsEnvironment({
        scope: readyScope,
        environments: [environment("mac", "MacBook"), environment("gpu3", "GPU3")],
        inventoryReady: true,
      }),
    ).toMatchObject({ phase: "blocked", reason: "ambiguous-code-computer" });
  });
});
