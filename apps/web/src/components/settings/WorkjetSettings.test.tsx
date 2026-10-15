import {
  DEFAULT_WORKJET_CONFIGURATION,
  EnvironmentId,
  WorkjetComputerId,
  WorkjetGreppyOperationError,
  WorkjetLlmRouteId,
  WorkjetWorkerProfileId,
  type GreppyRuntimeSnapshot,
} from "@workjet/contracts";
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
import { searchableSetting } from "./settingsSearch";
import {
  automaticWorktreeStorageControlState,
  WorktreeStorageInline,
  GreppyRuntimeSectionView,
  greppyOperationFailureDescription,
  greppyRuntimeAction,
  formatAvailableBytes,
  performAutomaticWorktreeStorageAction,
  performGreppyRuntimeInstall,
  WORKJET_SETTINGS_SECTIONS,
  WorkjetSettingsView,
  workjetSectionFromHash,
} from "./WorkjetSettings";

// Section titles come from the settings-search catalog (one source).
const GREPPY_TITLE = searchableSetting("greppy-runtime").title;

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
    onRemoveAccount: () => undefined,
    onAddApiKey: () => undefined,
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
        draftScopeKey="test-instance"
        configuration={DEFAULT_WORKJET_CONFIGURATION}
        greppy={greppy}
        gateway={gateway}
        onChange={() => undefined}
      />,
    );

    // Five tabs, with the editable worker graph beside the profile catalog.
    // re-mapping: Computers is a top-level settings page, provider accounts
    // and LLM routes live on Models, capabilities are toggled in the worker
    // editor, and the one-shot legacy import surface is gone. Every section
    // the catalog declares must actually render a tab.
    // Without developer mode only the preset list remains, so no tab bar.
    expect(WORKJET_SETTINGS_SECTIONS.map((section) => section.id)).not.toContain("organigram");
    expect(markup).not.toContain('role="tablist"');
    for (const gone of [
      "Provider accounts",
      "LLM routes",
      ">Capabilities<",
      ">Computers<",
      "Legacy import",
    ]) {
      expect(markup).not.toContain(gone);
    }
    // Page title is „Lumas“ (#568); the empty list is a title plus one primary action.
    expect(markup).toContain(">Lumas</h1>");
    expect(markup).toContain("Keine Worker-Presets");
    expect(markup).toContain("Preset hinzufügen");
    expect(markup).not.toContain("Connection targets");
    // The Greppy RUNTIME sits under Workers now — it supports composition.
    expect(markup).toContain(GREPPY_TITLE);
    expect(markup).not.toContain("remote execution is implemented");
    // No popups, no explanatory sentences, no wrench for the runtime.
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain("Compose reusable Lumas");
    expect(markup).not.toContain("lucide-wrench");
  });

  it("lists Lumas as rows with inline delete and a ⋯ menu, never a dialog", () => {
    const worker = {
      id: WorkjetWorkerProfileId.make("luma-1"),
      name: "Umsetzung",
      computerId: WorkjetComputerId.make("computer-missing"),
      harness: "claude-code" as const,
      llmRouteId: WorkjetLlmRouteId.make("route-1"),
      modelId: "claude-opus-5-5",
      reasoning: "high" as const,
      role: "standard" as const,
      capabilityIds: [],
      capabilityBindings: [],
    };
    const markup = renderToStaticMarkup(
      <WorkjetSettingsView
        draftScopeKey="test-instance"
        configuration={{ ...DEFAULT_WORKJET_CONFIGURATION, workerProfiles: [worker] }}
        greppy={greppy}
        gateway={gateway}
        onChange={() => undefined}
      />,
    );
    expect(markup).toContain('data-slot="row"');
    expect(markup).toContain(">Umsetzung<");
    // Meta: Modell · Harness · Rechner (missing → „Rechner: —“).
    expect(markup).toContain("claude-opus-5-5 · Claude Code · Rechner: —");
    expect(markup).toContain('aria-label="Löschen"');
    expect(markup).toContain("Weitere Aktionen");
    expect(markup).toContain("Rechner fehlt");
    expect(markup).not.toContain("computer-missing");
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain("Keine Lumas");
  });

  it("keeps telemetry free of the Greppy runtime, which lives under Workers", () => {
    const telemetryMarkup = renderToStaticMarkup(
      <WorkjetSettingsView
        draftScopeKey="test-instance"
        configuration={DEFAULT_WORKJET_CONFIGURATION}
        greppy={greppy}
        gateway={gateway}
        defaultSection="telemetry"
        onChange={() => undefined}
      />,
    );
    expect(telemetryMarkup).toContain("Claude-Code-Ereignisse");
    expect(telemetryMarkup).toContain("Luma-Ereignisse");
    expect(telemetryMarkup).toContain("Aufbewahrung (Tage)");
    expect(telemetryMarkup).not.toContain(GREPPY_TITLE);

    const capabilitiesMarkup = renderToStaticMarkup(
      <WorkjetSettingsView
        draftScopeKey="test-instance"
        configuration={DEFAULT_WORKJET_CONFIGURATION}
        greppy={greppy}
        gateway={gateway}
        defaultSection="workers"
        onChange={() => undefined}
      />,
    );
    expect(capabilitiesMarkup).toContain(GREPPY_TITLE);
  });

  it("keeps worktree storage out of Execution; it lives on the Rechner page (#619)", () => {
    const markup = renderToStaticMarkup(
      <WorkjetSettingsView
        draftScopeKey="test-instance"
        configuration={DEFAULT_WORKJET_CONFIGURATION}
        greppy={greppy}
        gateway={gateway}
        defaultSection="execution"
        onChange={() => undefined}
      />,
    );
    expect(markup).not.toContain(searchableSetting("automatic-worktree-storage").title);
    expect(
      renderToStaticMarkup(<WorktreeStorageInline storage={automaticWorktreeStorage} />),
    ).toContain("125 GB frei");
    expect(formatAvailableBytes(1_500_000_000)).toBe("1.50 GB");
    expect(formatAvailableBytes(Number.NaN)).toBe("—");
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
    // Computers is its own page now; its anchor no longer selects a tab here.
    expect(workjetSectionFromHash("#workjet-computers")).toBeNull();
    expect(workjetSectionFromHash("workjet-telemetry")).toBe("telemetry");
    expect(workjetSectionFromHash("#workjet-organigram")).toBeNull();
    expect(workjetSectionFromHash("#greppy-runtime")).toBe("workers");
    expect(workjetSectionFromHash("#unknown")).toBeNull();
  });

  // The provider-accounts pointer tab is gone entirely: the surface lives on
  // Settings → Models, and a tab whose only content is a link to another page
  // is navigation debt rather than a section.
});

describe("Workjet Greppy runtime settings", () => {
  it("registers the Worker sidebar destination, plus Computers at top level", () => {
    // The operator's naming, given twice: the section configures WORKERS, and
    // machines are not a detail of it — a worker references a computer, so
    // Computers stands beside Models and Harnesses.
    expect(SETTINGS_NAV_ITEMS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Lumas", to: "/settings/workjet" }),
        expect.objectContaining({ label: "Rechner", to: "/settings/computers" }),
      ]),
    );
  });

  it("renders loading, available, unavailable, unsupported, and typed failure states", () => {
    expect(render(null, { loading: true })).toContain("Prüft …");
    expect(render({ ...baseSnapshot, availability: "available", source: "managed" })).toContain(
      "Verfügbar · Von Workjet verwaltet · 0.3.1",
    );
    expect(
      render({ ...baseSnapshot, availability: "unavailable", reason: "path-unavailable" }),
    ).toContain("Nicht verfügbar");
    expect(
      render({
        ...baseSnapshot,
        availability: "unsupported",
        reason: "unsupported-host",
        installSupported: false,
      }),
    ).toContain("Installation hier nicht unterstützt");
    expect(render(null, { failure: true })).toContain('role="alert"');
    // A runtime icon, never the wrench (UI-Vertrag §5).
    expect(render(null)).toContain("lucide-terminal");
    expect(render(null)).not.toContain("lucide-wrench");
  });

  it("offers install, repair, refresh, and override guidance without exposing store paths", () => {
    const installMarkup = render({
      ...baseSnapshot,
      availability: "unavailable",
      reason: "path-unavailable",
    });
    expect(installMarkup).toContain("Greppy installieren");
    expect(installMarkup).toContain("Erneut prüfen");

    const repairMarkup = render({
      ...baseSnapshot,
      availability: "unavailable",
      reason: "managed-invalid",
    });
    expect(repairMarkup).toContain("Greppy reparieren");

    const overrideMarkup = render({
      ...baseSnapshot,
      availability: "unavailable",
      reason: "override-invalid",
    });
    expect(overrideMarkup).toContain("WORKJET_GREPPY_EXECUTABLE");
    expect(overrideMarkup).not.toContain("Greppy installieren");
    expect(overrideMarkup).not.toContain("Greppy reparieren");
    expect(overrideMarkup).not.toContain("/greppy");

    // Status line only: the old explanatory row is gone.
    expect(installMarkup).not.toContain("Codex, Claude, and Grok threads");
    expect(installMarkup).not.toContain("Shared server capability");
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
      title: "Greppy installiert",
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
      title: "Greppy-Reparatur fehlgeschlagen",
      description: "Greppy-Vorgang fehlgeschlagen.",
    });
    expect(JSON.stringify(failureToast)).not.toContain(internalText);
    expect(greppyOperationFailureDescription(new Error(internalText))).not.toContain(internalText);
  });
});
