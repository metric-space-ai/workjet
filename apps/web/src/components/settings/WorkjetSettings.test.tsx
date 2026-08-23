import {
  DEFAULT_WORKJET_CONFIGURATION,
  EnvironmentId,
  WorkjetGatewayAccountId,
  WorkjetGreppyOperationError,
  type GreppyRuntimeSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...original,
    useNavigate: () => () => Promise.resolve(),
    useLocation: ({ select }: { select: (location: { hash: string }) => unknown }) =>
      select({ hash: "" }),
  };
});

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";
import {
  automaticWorktreeStorageControlState,
  GreppyRuntimeSectionView,
  greppyOperationFailureDescription,
  greppyRuntimeAction,
  formatAvailableBytes,
  performAutomaticWorktreeStorageAction,
  performGreppyRuntimeInstall,
  WorkjetSettingsView,
  workjetSectionFromHash,
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

describe("Workjet configuration settings", () => {
  const greppy = {
    snapshot: null,
    isInitialLoading: false,
    hasInspectFailure: false,
    isRefreshing: false,
    isOperating: false,
    onRefresh: () => undefined,
    onInstall: () => undefined,
  };
  const gateway = {
    status: null,
    catalog: null,
    isInitialLoading: false,
    isRefreshing: false,
    statusError: null,
    catalogError: null,
    isOperating: false,
    login: { status: "idle" as const },
    onRefresh: () => undefined,
    onRetry: () => undefined,
    onAddAccount: () => undefined,
    onCancelLogin: () => undefined,
    apiKey: { status: "idle" as const },
    onAddApiKey: () => undefined,
  };
  const legacyImport = {
    hasOffer: false,
    draft: {},
    onAnswer: () => undefined,
    state: {
      inspection: { schemaVersion: 1 as const, state: "nothing-to-import" as const },
      isInitialLoading: false,
      hasInspectFailure: false,
      isRefreshing: false,
      isDeciding: false,
      error: null,
      onRefresh: () => undefined,
      onAccept: () => undefined,
      onDecline: () => undefined,
    },
  };
  const automaticWorktreeStorage = {
    configuredRoot: "",
    selectedServerLabel: "Code server",
    selectedServerId: EnvironmentId.make("code-server"),
    inspection: {
      status: "valid" as const,
      requestedRoot: "",
      configuredRoot: "",
      defaultRoot: "/srv/workjet/worktrees",
      effectiveRoot: "/srv/workjet/worktrees",
      canonicalRoot: "/srv/workjet/worktrees",
      writable: true as const,
      availableBytes: 125_000_000_000,
    },
    error: null,
    isChecking: false,
    isApplying: false,
    onCheck: () => undefined,
    onApply: () => undefined,
  };

  it("renders compact tabs and opens workers by default", () => {
    const markup = renderToStaticMarkup(
      <WorkjetSettingsView
        configuration={DEFAULT_WORKJET_CONFIGURATION}
        environments={[]}
        environmentsReady={false}
        greppy={greppy}
        gateway={gateway}
        automaticWorktreeStorage={automaticWorktreeStorage}
        legacyImport={legacyImport}
        onChange={() => undefined}
      />,
    );

    const tabs = [
      "Workers",
      "Computers",
      "Provider accounts",
      "LLM routes",
      "Prompt",
      "Telemetry",
      "Execution",
      "Capabilities",
      "Legacy import",
    ];
    for (const tab of tabs) expect(markup).toContain(`>${tab}<`);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("No saved workers");
    expect(markup).not.toContain("Connection targets");
    expect(markup).not.toContain("Greppy Runtime");
    expect(markup).not.toContain("remote execution is implemented");
  });

  it("opens telemetry and capabilities as distinct settings areas", () => {
    const telemetryMarkup = renderToStaticMarkup(
      <WorkjetSettingsView
        configuration={DEFAULT_WORKJET_CONFIGURATION}
        environments={[]}
        environmentsReady
        greppy={greppy}
        gateway={gateway}
        automaticWorktreeStorage={automaticWorktreeStorage}
        legacyImport={legacyImport}
        defaultSection="telemetry"
        onChange={() => undefined}
      />,
    );
    expect(telemetryMarkup).toContain("Claude Code events");
    expect(telemetryMarkup).toContain("Sidecar events");
    expect(telemetryMarkup).toContain("Workjet telemetry retention days");
    expect(telemetryMarkup).not.toContain("Greppy Runtime");

    const capabilitiesMarkup = renderToStaticMarkup(
      <WorkjetSettingsView
        configuration={DEFAULT_WORKJET_CONFIGURATION}
        environments={[]}
        environmentsReady
        greppy={greppy}
        gateway={gateway}
        automaticWorktreeStorage={automaticWorktreeStorage}
        legacyImport={legacyImport}
        defaultSection="capabilities"
        onChange={() => undefined}
      />,
    );
    expect(capabilitiesMarkup).toContain("Shared capabilities");
    expect(capabilitiesMarkup).toContain("Greppy Runtime");
  });

  it("shows selected-server automatic storage health in Execution", () => {
    const markup = renderToStaticMarkup(
      <WorkjetSettingsView
        configuration={DEFAULT_WORKJET_CONFIGURATION}
        environments={[]}
        environmentsReady
        greppy={greppy}
        gateway={gateway}
        automaticWorktreeStorage={{
          ...automaticWorktreeStorage,
          configuredRoot: "/Volumes/worktrees",
          inspection: {
            ...automaticWorktreeStorage.inspection,
            requestedRoot: "/Volumes/worktrees",
            configuredRoot: "/Volumes/worktrees",
            effectiveRoot: "/Volumes/worktrees",
            canonicalRoot: "/Volumes/worktrees",
          },
        }}
        legacyImport={legacyImport}
        defaultSection="execution"
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain("Automatic worktree storage");
    expect(markup).toContain("Selected server: Code server · code-server");
    expect(markup).toContain("Writable · 125 GB available");
    expect(markup).toContain("Effective canonical path:");
    expect(markup).toContain("Use default");
    expect(markup).toContain(
      "Only newly created automatic worktrees use the location; existing worktrees are not moved.",
    );
    expect(formatAvailableBytes(1_500_000_000)).toBe("1.50 GB");
  });

  it("checks, applies, and resets storage only through valid selected-server controls", () => {
    const onCheck = vi.fn();
    const onApply = vi.fn();
    const storage = {
      ...automaticWorktreeStorage,
      configuredRoot: "/srv/worktrees-a",
      inspection: {
        ...automaticWorktreeStorage.inspection,
        requestedRoot: "/srv/worktrees-b",
        configuredRoot: "/srv/worktrees-a",
        effectiveRoot: "/srv/worktrees-a",
        canonicalRoot: "/srv/worktrees-b",
      },
      onCheck,
      onApply,
    };

    expect(automaticWorktreeStorageControlState(storage, "  /srv/worktrees-b  ")).toMatchObject({
      requestedRoot: "/srv/worktrees-b",
      canCheck: true,
      canApply: true,
      canReset: true,
    });
    performAutomaticWorktreeStorageAction(storage, "check", "  /srv/worktrees-b  ");
    performAutomaticWorktreeStorageAction(storage, "apply", "  /srv/worktrees-b  ");
    performAutomaticWorktreeStorageAction(storage, "reset", "  /srv/worktrees-b  ");
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(onCheck).toHaveBeenCalledWith("/srv/worktrees-b");
    expect(onApply.mock.calls).toEqual([["/srv/worktrees-b"], [""]]);

    const staleInspection = {
      ...storage,
      inspection: { ...storage.inspection, requestedRoot: "/srv/other" },
    };
    expect(automaticWorktreeStorageControlState(staleInspection, "/srv/worktrees-b").canApply).toBe(
      false,
    );
    performAutomaticWorktreeStorageAction(staleInspection, "apply", "/srv/worktrees-b");
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  it("maps settings-search targets to their tab", () => {
    expect(workjetSectionFromHash("#workjet-computers")).toBe("computers");
    expect(workjetSectionFromHash("workjet-telemetry")).toBe("telemetry");
    expect(workjetSectionFromHash("#greppy-runtime")).toBe("capabilities");
    expect(workjetSectionFromHash("#unknown")).toBeNull();
  });

  it("points the provider-accounts tab at the Models page", () => {
    const markup = renderToStaticMarkup(
      <WorkjetSettingsView
        configuration={DEFAULT_WORKJET_CONFIGURATION}
        environments={[]}
        environmentsReady
        greppy={greppy}
        gateway={{
          ...gateway,
          catalog: {
            schemaVersion: 1,
            accounts: [
              {
                id: WorkjetGatewayAccountId.make("account-claude-1"),
                label: "Claude Work",
                provider: "claude",
                enabled: true,
                priority: 1,
                weight: 1,
                modelIds: ["claude-opus"],
                credentialSuffix: null,
              },
            ],
            pools: [],
            routes: [],
            models: [],
            routingStrategy: "round-robin",
            providerPools: [],
          },
        }}
        automaticWorktreeStorage={automaticWorktreeStorage}
        legacyImport={legacyImport}
        defaultSection="provider-accounts"
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain("Provider accounts moved to Settings → Models");
    expect(markup).toContain('href="/settings/models#workjet-provider-accounts"');
    // The tab must not duplicate the interactive gateway surface.
    expect(markup).not.toContain("Add account");
    expect(markup).not.toContain("Claude Work");
    expect(markup).not.toContain("Start gateway");
  });
});

describe("Workjet Greppy runtime settings", () => {
  it("registers the Worker sidebar destination, plus Computers at top level", () => {
    // The operator's naming, given twice: the section configures WORKERS, and
    // machines are not a detail of it — a worker references a computer, so
    // Computers stands beside Models and Harnesses.
    expect(SETTINGS_NAV_ITEMS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Worker", to: "/settings/workjet" }),
        expect.objectContaining({ label: "Computers", to: "/settings/computers" }),
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
