import {
  EnvironmentId,
  WorkjetGreppyOperationError,
  type GreppyRuntimeSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";
import {
  GreppyRuntimeSectionView,
  greppyOperationFailureDescription,
  greppyRuntimeAction,
  performGreppyRuntimeInstall,
} from "./WorkjetSettings";

const baseSnapshot = {
  version: "0.3.1",
  installSupported: true,
} as const;

function render(
  snapshot: GreppyRuntimeSnapshot | null,
  overrides?: { loading?: boolean; failure?: boolean },
) {
  return renderToStaticMarkup(
    <GreppyRuntimeSectionView
      snapshot={snapshot}
      isInitialLoading={overrides?.loading ?? false}
      hasInspectFailure={overrides?.failure ?? false}
      isRefreshing={false}
      isOperating={false}
      onRefresh={() => undefined}
      onInstall={() => undefined}
    />,
  );
}

describe("Workjet Greppy runtime settings", () => {
  it("registers the Workjet sidebar destination", () => {
    expect(SETTINGS_NAV_ITEMS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Workjet", to: "/settings/workjet" }),
      ]),
    );
  });

  it("renders loading, available, unavailable, unsupported, and typed failure states", () => {
    expect(render(null, { loading: true })).toContain("Checking the selected server");
    expect(render({ ...baseSnapshot, availability: "available", source: "managed" })).toContain(
      "Pinned version 0.3.1",
    );
    expect(
      render({ ...baseSnapshot, availability: "unavailable", reason: "path-unavailable" }),
    ).toContain("Unavailable");
    expect(
      render({
        ...baseSnapshot,
        availability: "unsupported",
        reason: "unsupported-host",
        installSupported: false,
      }),
    ).toContain("Managed install unsupported");
    expect(render(null, { failure: true })).toContain('role="alert"');
  });

  it("offers install, repair, refresh, and override guidance without exposing store paths", () => {
    const installMarkup = render({
      ...baseSnapshot,
      availability: "unavailable",
      reason: "path-unavailable",
    });
    expect(installMarkup).toContain("Install Greppy");
    expect(installMarkup).toContain("Check again");

    const repairMarkup = render({
      ...baseSnapshot,
      availability: "unavailable",
      reason: "managed-invalid",
    });
    expect(repairMarkup).toContain("Repair Greppy");

    const overrideMarkup = render({
      ...baseSnapshot,
      availability: "unavailable",
      reason: "override-invalid",
    });
    expect(overrideMarkup).toContain("WORKJET_GREPPY_EXECUTABLE");
    expect(overrideMarkup).not.toContain("Install Greppy");
    expect(overrideMarkup).not.toContain("Repair Greppy");
    expect(overrideMarkup).not.toContain("/greppy");

    expect(installMarkup).toContain("all Codex, Claude, and Grok threads on this server");
    expect(installMarkup).toContain("activation remains configured per thread");
  });

  it("derives the correct action from authoritative snapshots", () => {
    expect(
      greppyRuntimeAction({
        ...baseSnapshot,
        availability: "unavailable",
        reason: "path-unavailable",
      }),
    ).toBe("install");
    expect(
      greppyRuntimeAction({
        ...baseSnapshot,
        availability: "unavailable",
        reason: "managed-invalid",
      }),
    ).toBe("repair");
    expect(
      greppyRuntimeAction({
        ...baseSnapshot,
        availability: "unavailable",
        reason: "override-invalid",
      }),
    ).toBeNull();
    expect(
      greppyRuntimeAction({ ...baseSnapshot, availability: "available", source: "path" }),
    ).toBeNull();
  });

  it("reports success and bounds failure toasts", async () => {
    const addToast = vi.fn();
    const environmentId = EnvironmentId.make("environment-1");
    await performGreppyRuntimeInstall({
      environmentId,
      action: "install",
      install: async () =>
        AsyncResult.success({ ...baseSnapshot, availability: "available", source: "managed" }),
      addToast: addToast as never,
    });
    expect(addToast).toHaveBeenCalledWith({
      type: "success",
      title: "Greppy installed",
      description: "Server runtime status was refreshed.",
    });

    const internalText = "/private/state stderr=https://credential.example.test";
    await performGreppyRuntimeInstall({
      environmentId,
      action: "repair",
      install: async () =>
        AsyncResult.failure(
          Cause.fail(
            Object.assign(new WorkjetGreppyOperationError({ reason: "install-failed" }), {
              internalText,
            }),
          ),
        ),
      addToast: addToast as never,
    });
    const failureToast = addToast.mock.calls.at(-1)?.[0];
    expect(failureToast).toMatchObject({
      type: "error",
      title: "Could not repair Greppy",
      description: "The managed Greppy runtime operation failed.",
    });
    expect(JSON.stringify(failureToast)).not.toContain(internalText);
    expect(greppyOperationFailureDescription(new Error(internalText))).not.toContain(internalText);
  });
});
