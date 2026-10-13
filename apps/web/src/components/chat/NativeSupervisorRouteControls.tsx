import {
  WS_METHODS,
  extractLumaInstanceDocument,
  type WorkjetLumaSnapshot,
  type WorkjetWorkerProfile,
  type WorkjetComputer,
  type WorkjetGatewayModelSummary,
  type WorkjetHarness,
  type CtoxWorkjetComputerProjection,
  type EnvironmentId,
} from "@workjet/contracts";
import { createEnvironmentRpcCommand } from "@workjet/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { InlineExpand } from "../ui/inline-expand";
import { WorkjetComputersSettings } from "../settings/WorkjetComputersSettings";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { readActiveWorkjetScope } from "../../activeWorkjetScope";
import {
  businessOsCodeScopeContainsEnvironment,
  useBusinessOsCodeScope,
} from "../../businessOsCodeScope";
import type { NativeSupervisorScope } from "../../nativeSupervisorComposer";
import { usePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment, useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { connectionAtomRuntime } from "../../connection/runtime";
import { includeSavedComputers } from "../../workjetComputerCatalog";
import { workjetEnvironmentTargetOptions } from "../settings/workjetEnvironmentTargetOptions";
import { workjetComputerMembership } from "../../workjetComputerMembership";
import {
  recordWorkjetProjectProjection,
  refreshWorkjetProjectRegistry,
  useWorkjetProjectRegistry,
} from "../../workjetProjectRegistry";
import {
  isSupervisorManualProfile,
  prepareSupervisorManualChoice,
  persistSupervisorComposerSelection,
  supervisorSelectionForHarness,
  type SupervisorManualSelection,
} from "../../supervisorComposerSelection";
import { useProjectSupervisorLumas } from "../ProjectSupervisorLumaField";
import { ComposerWorkerControl, providerInstanceIdForHarness } from "./ComposerWorkerControl";
import {
  ComposerManualTargetControls,
  ComposerComputerControl,
} from "./ComposerWorkjetTargetControls";
import { useSupervisorRouteDisplay } from "./useSupervisorRouteDisplay";

const readInstanceConfiguration = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "supervisor-composer:read-luma-configuration",
  tag: WS_METHODS.workjetLumaRead,
});

export function NativeSupervisorRouteControls(props: {
  readonly scope: NativeSupervisorScope | null;
  readonly workerSourceBinding?:
    | { readonly connectionId: string; readonly instanceId?: string }
    | undefined;
  readonly disabled: boolean;

  readonly onSavingChange: (saving: boolean) => void;
  readonly onStatusChange?: (status: string | null) => void;
}) {
  const registry = useWorkjetProjectRegistry(props.scope?.instanceId ?? null);
  const lumas = useProjectSupervisorLumas(props.workerSourceBinding);
  const codeScope = useBusinessOsCodeScope();
  const environment = usePrimaryEnvironment();
  const local = usePrimarySettings((settings) => settings.workjet);
  const { environments } = useEnvironments();
  const membership = useSyncExternalStore(
    workjetComputerMembership.subscribe,
    workjetComputerMembership.getSnapshot,
    workjetComputerMembership.getSnapshot,
  );
  const computers = includeSavedComputers(
    local,
    workjetEnvironmentTargetOptions(environments),
    environment?.environmentId ?? null,
  ).computers.filter(
    (computer) =>
      businessOsCodeScopeContainsEnvironment(codeScope, computer.environmentId) ||
      (lumas.instanceId === props.scope?.instanceId &&
        lumas.profiles.some((profile) => profile.computerId === computer.id)) ||
      (membership.instanceId === props.scope?.instanceId &&
        membership.computers.some((entry) => entry.id === computer.id)),
  );
  const target = lumas.instanceId === props.scope?.instanceId ? (lumas.target ?? null) : null;
  const instance = useEnvironmentQuery(
    target && environment
      ? serverEnvironment.lumaConfiguration({
          environmentId: environment.environmentId,
          input: target,
        })
      : null,
  );
  const catalog = useEnvironmentQuery(
    environment
      ? serverEnvironment.workjetGatewayCatalog({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const write = useAtomCommand(serverEnvironment.updateLumaConfiguration, { reportFailure: false });
  const read = useAtomCommand(readInstanceConfiguration, { reportFailure: false });
  const route = useSupervisorRouteDisplay(props.scope);
  const navigate = useNavigate();
  const [addComputerOpen, setAddComputerOpen] = useState(false);
  const project = registry.projects.find((entry) => entry.id === props.scope?.projectId);
  const selectedId =
    project?.supervisorLumaId ??
    (route?.phase === "ready" ? route.route.configured?.luma_id : null) ??
    null;
  const [verified, setVerified] = useState<{
    scopeKey: string;
    snapshot: WorkjetLumaSnapshot;
  } | null>(null);
  const snapshot =
    verified?.scopeKey === JSON.stringify(props.scope) &&
    verified.snapshot.revision >= (instance.data?.revision ?? 0)
      ? verified.snapshot
      : instance.data;
  const configuration =
    snapshot?.configuration ??
    lumas.configuration ??
    (snapshot?.revision === 0 ? extractLumaInstanceDocument(local) : null);
  const profiles = configuration?.workerProfiles ?? lumas.profiles;
  const selected = profiles.find((profile) => profile.id === selectedId) ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const scopeKey = JSON.stringify(props.scope);
  const currentKey = useRef(scopeKey);
  currentKey.current = scopeKey;
  const ready =
    props.scope !== null &&
    registry.presentationInstanceId === props.scope.instanceId &&
    lumas.instanceId === props.scope.instanceId &&
    target !== null &&
    lumas.phase === "ready" &&
    configuration !== null &&
    project !== undefined;
  const status =
    error ??
    (saving
      ? "Wird gespeichert …"
      : !ready
        ? lumas.phase === "loading"
          ? "Wird geladen …"
          : "Instanz-Konfiguration nicht verfügbar"
        : selectedId !== null && selected === null
          ? "Gespeicherte Supervisor-Luma nicht verfügbar"
          : null);
  useEffect(() => {
    props.onStatusChange?.(status);
  }, [status, props.onStatusChange]);
  useEffect(() => {
    setError(null);
    return () => {
      operation.current?.abort();
      operation.current = null;
      props.onSavingChange(false);
    };
  }, [scopeKey, props.onSavingChange]);

  async function choose(value: string | SupervisorManualSelection | null) {
    if (props.disabled || operation.current) return;
    if (
      !ready ||
      !props.scope ||
      !project ||
      !environment ||
      !target ||
      !snapshot ||
      !configuration
    ) {
      setError("Instanz-Konfiguration nicht verfügbar");
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    const selection = readActiveWorkjetScope();
    const scope = props.scope;
    setSaving(true);
    props.onSavingChange(true);
    setError(null);
    const isCurrent = () =>
      currentKey.current === scopeKey &&
      readActiveWorkjetScope().selectedInstanceId === scope.instanceId &&
      readActiveWorkjetScope().selectionRevision === selection.selectionRevision;
    try {
      const prepared =
        typeof value === "string"
          ? profiles.find((entry) => entry.id === value)
          : prepareSupervisorManualChoice({
              projectId: scope.projectId,
              selection:
                value ??
                selected ??
                (() => {
                  throw new Error("Zuerst Harness wählen");
                })(),
              configuration,
              computers,
              models: catalog.data?.models ?? [],
            });
      if (!prepared) throw new Error("Luma nicht verfügbar");
      const profile = "profile" in prepared ? prepared.profile : prepared;
      const selectedConfiguration =
        "configuration" in prepared ? prepared.configuration : configuration;
      const persisted = await persistSupervisorComposerSelection({
        scope,
        project,
        profile,
        snapshot: { ...snapshot, configuration: selectedConfiguration },
        signal: controller.signal,
        isCurrent,
        writeConfiguration: async (configuration, expectedRevision) => {
          const result = await write({
            environmentId: environment.environmentId,
            input: { target, expectedRevision, configuration },
          });
          if (result._tag !== "Success") throw new Error("Instanz hat die Konfiguration abgelehnt");
          return result.value.status;
        },
        readConfiguration: async () => {
          const result = await read({ environmentId: environment.environmentId, input: target });
          if (result._tag !== "Success") throw new Error("Konfiguration nicht lesbar");
          if (isCurrent() && !controller.signal.aborted)
            setVerified({ scopeKey, snapshot: result.value });
          return result.value;
        },
      });
      if (!isCurrent() || controller.signal.aborted) return;
      recordWorkjetProjectProjection(scope.instanceId, persisted);
      refreshWorkjetProjectRegistry(scope.instanceId);
      instance.refresh();
    } catch (failure) {
      if (isCurrent() && !controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : "Speichern fehlgeschlagen");
        instance.refresh();
        refreshWorkjetProjectRegistry(scope.instanceId);
      }
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setSaving(false);
        props.onSavingChange(false);
      }
    }
  }
  const activeComputer =
    selected?.computerId ??
    (route?.phase === "ready"
      ? computers.find((entry) => entry.id === route.route.configured?.computer_id)?.id
      : null) ??
    null;
  const models = [...(catalog.data?.models ?? [])];
  for (const profile of profiles)
    if (!models.some((model) => model.id === profile.modelId))
      models.push({
        id: profile.modelId,
        displayName: profile.modelId,
        providers: [],
        accountIds: [],
      });
  return (
    <>
      <NativeSupervisorRouteControlsView
        projectId={props.scope?.projectId ?? ""}
        selected={selected}
        profiles={profiles}
        computers={computers}
        models={models}
        registeredComputers={
          membership.instanceId === props.scope?.instanceId ? membership.computers : []
        }
        environmentId={environment?.environmentId ?? null}
        selectedComputerId={activeComputer}
        disabled={props.disabled || saving}
        unavailableReason={!ready ? status : null}
        computerAvailability={Object.fromEntries(
          computers.map((computer) => {
            const connection = environments.find(
              (entry) => entry.environmentId === computer.environmentId,
            )?.connection;
            return [
              computer.id,
              {
                status:
                  connection?.phase === "connected"
                    ? "Online"
                    : connection?.phase === "offline"
                      ? "Offline"
                      : "Getrennt",
                reason:
                  !profiles.some((entry) => entry.computerId === computer.id) &&
                  connection?.phase !== "connected"
                    ? (connection?.error ?? "Rechner offline")
                    : null,
              },
            ];
          }),
        )}
        onSelectWorker={(id) => void choose(id)}
        onSelectManual={(next) => void choose(next)}
        onError={setError}
        onConfigureWorkers={() => void navigate({ to: "/settings/workjet" })}
        onAddComputer={() => setAddComputerOpen(true)}
        onSetupHarness={() => void navigate({ to: "/settings/harnesses" })}
        onHarnessMenuOpen={() => {
          // Erkennung nach einer Installation ohne App-Neustart neu anstoßen.
          instance.refresh();
          catalog.refresh();
        }}
      />
      {/* Full-width row under the controls; same panel as the chat composer (#528). */}
      <div className="w-full basis-full" data-supervisor-add-computer="true">
        <InlineExpand
          open={addComputerOpen}
          onOpenChange={setAddComputerOpen}
          label={supervisorAddComputerLabel()}
          className="mt-2 rounded-2xl border bg-card p-3 pe-9"
        >
          <WorkjetComputersSettings setupOnly onCompleted={() => setAddComputerOpen(false)} />
        </InlineExpand>
      </div>
    </>
  );
}

/** Identical controls to an ordinary thread; only persistence belongs to the project route. */
export function NativeSupervisorRouteControlsView(props: {
  readonly projectId: string;
  readonly selected: WorkjetWorkerProfile | null;
  readonly profiles: readonly WorkjetWorkerProfile[];
  readonly computers: readonly WorkjetComputer[];
  readonly registeredComputers?: readonly CtoxWorkjetComputerProjection[];
  readonly models: readonly WorkjetGatewayModelSummary[];
  readonly environmentId: EnvironmentId | null;
  readonly selectedComputerId: WorkjetComputer["id"] | null;
  readonly disabled: boolean;
  readonly unavailableReason: string | null;
  readonly computerAvailability?: Readonly<
    Record<string, { readonly status: string; readonly reason: string | null }>
  >;
  readonly onSelectWorker: (id: string | null) => void;
  readonly onSelectManual: (selection: SupervisorManualSelection) => void;
  readonly onError: (error: string) => void;
  readonly onConfigureWorkers: () => void;
  readonly onAddComputer: () => void;
  readonly onSetupHarness?: ((harness: WorkjetHarness) => void) | undefined;
  readonly onHarnessMenuOpen?: (() => void) | undefined;
}) {
  const manual =
    props.selected === null || isSupervisorManualProfile(props.selected, props.projectId);
  const selected = props.selected;
  const harnesses = new Set<string>();
  for (const profile of props.profiles) {
    const driver = providerInstanceIdForHarness(profile.harness);
    if (driver) harnesses.add(driver);
  }
  for (const computer of props.computers)
    for (const entry of computer.harnesses)
      if (entry.available) {
        const driver = providerInstanceIdForHarness(entry.harness);
        if (driver) harnesses.add(driver);
      }
  const change = (next: SupervisorManualSelection) => {
    if (props.unavailableReason) props.onError(props.unavailableReason);
    else props.onSelectManual(next);
  };
  return (
    <>
      <ComposerWorkerControl
        workers={props.profiles.filter((entry) => !entry.id.startsWith("supervisor-manual:"))}
        selectedWorkerId={manual ? null : (selected?.id ?? null)}
        disabled={props.disabled}
        onSelectWorker={props.onSelectWorker}
        onOpenWorkjetSettings={props.onConfigureWorkers}
      />
      {manual && (
        <>
          <ComposerManualTargetControls
            configuredInstanceIds={harnesses}
            selectedHarness={selected?.harness ?? null}
            unavailableHint="Kein Modell verfügbar"
            onSelectHarness={(harness) => {
              try {
                change(
                  supervisorSelectionForHarness(
                    harness,
                    selected,
                    props.profiles,
                    props.selectedComputerId ??
                      props.computers.find(
                        (computer) => computer.environmentId === props.environmentId,
                      )?.id ??
                      null,
                  ),
                );
              } catch (failure) {
                props.onError(
                  failure instanceof Error ? failure.message : "Harness nicht verfügbar",
                );
              }
            }}
            disabledReason={props.disabled ? "Vorgang läuft noch" : null}
            modelSource="configured"
            configuredModelsHint={null}
            models={props.models}
            modelsUnavailableReason={props.unavailableReason ?? "Keine Modelle konfiguriert"}
            selectedModelId={selected?.modelId ?? ""}
            onSelectModel={(modelId) => {
              if (!selected) {
                props.onError("Zuerst Harness wählen");
                return;
              }
              change({ ...selected, modelId });
            }}
            onSetupHarness={props.onSetupHarness}
            onHarnessMenuOpen={props.onHarnessMenuOpen}
          />
          {props.environmentId && (
            <ComposerComputerControl
              computers={props.computers}
              registeredComputers={props.registeredComputers ?? []}
              computerAvailability={props.computerAvailability ?? {}}
              selectedComputerId={props.selectedComputerId}
              activeEnvironmentId={props.environmentId}
              selectableEnvironmentIds={props.computers.map((entry) => entry.environmentId)}
              disabledReason={props.disabled ? "Vorgang läuft noch" : props.unavailableReason}
              mismatchNote={null}
              onAddComputer={props.onAddComputer}
              onSelectComputer={(id) => {
                if (!selected) {
                  props.onError("Zuerst Harness wählen");
                  return;
                }
                const computer = props.computers.find((entry) => entry.id === id);
                if (computer) change({ ...selected, computerId: computer.id });
              }}
            />
          )}
        </>
      )}
    </>
  );
}

export function supervisorAddComputerLabel(
  language: "de" | "en" = typeof document !== "undefined" &&
  document.documentElement.lang.toLowerCase().startsWith("en")
    ? "en"
    : "de",
): string {
  return language === "en" ? "Add computer" : "Rechner hinzufügen";
}
