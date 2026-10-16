import {
  WorkjetLumaInstanceConfiguration as WorkjetLumaInstanceConfigurationSchema,
  WorkjetLumaTarget as WorkjetLumaTargetSchema,
  type WorkjetWorkerProfile,
  type WorkjetLumaTarget,
} from "@workjet/contracts";
import { Schema } from "effect";

type WorkjetLumaInstanceConfiguration = typeof WorkjetLumaInstanceConfigurationSchema.Type;
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "./ui/button";
import { OptionSelect } from "./ui/option-select";
import { useBusinessOsCodeScope } from "../businessOsCodeScope";
import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { lumaConnectionForInstance } from "../workjetCtoxConnections";
import { workjetHarnessDisplayLabel } from "./settings/WorkjetWorkerEditor";

export type LumaFieldProps = {
  readonly id: string;
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
  readonly disabled: boolean;
};

/**
 * Lokaler Zwischenspeicher der zuletzt bekannten Supervisor-Lumas je Instanz.
 * Ein langsamer oder gescheiterter Abruf zeigt nie eine leere Liste, sondern
 * diesen Stand; ein erfolgreicher Abruf überschreibt ihn.
 */
const LUMA_CACHE_PREFIX = "workjet.supervisor-lumas.v1:";

const CachedSupervisorLumasSchema = Schema.Struct({
  instanceName: Schema.NullOr(Schema.String),
  target: Schema.NullOr(WorkjetLumaTargetSchema),
  configuration: Schema.NullOr(WorkjetLumaInstanceConfigurationSchema),
});
type CachedSupervisorLumas = typeof CachedSupervisorLumasSchema.Type;

export function readCachedSupervisorLumas(instanceId: string | null): CachedSupervisorLumas | null {
  if (instanceId === null || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(LUMA_CACHE_PREFIX + instanceId);
    if (raw === null) return null;
    return Schema.decodeUnknownSync(CachedSupervisorLumasSchema)(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeCachedSupervisorLumas(instanceId: string, value: CachedSupervisorLumas): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LUMA_CACHE_PREFIX + instanceId, JSON.stringify(value));
  } catch {
    // Ein voller oder gesperrter Speicher darf die Leiste nie stören.
  }
}

/** The local server is only transport; profiles belong to the selected native instance. */
export function useProjectSupervisorLumas(boundSource?: {
  readonly connectionId: string;
  readonly instanceId?: string;
}): {
  readonly instanceId: string | null;
  readonly instanceName: string | null;
  readonly target: WorkjetLumaTarget | null;
  readonly phase: "loading" | "ready" | "unavailable";
  readonly profiles: readonly WorkjetWorkerProfile[];
  /** Live gelesene oder zuletzt bekannte Instanz-Konfiguration. */
  readonly configuration: WorkjetLumaInstanceConfiguration | null;
  /** Fragt Verbindungen und Preset-Konfiguration erneut ab. */
  readonly retry: () => void;
} {
  const scope = useBusinessOsCodeScope();
  const environment = usePrimaryEnvironment();
  const connections = useEnvironmentQuery(
    environment === null || scope.phase !== "ready"
      ? null
      : serverEnvironment.workjetDecisionHubConnections({
          environmentId: environment.environmentId,
          input: {},
        }),
  );
  const connection =
    scope.phase === "ready"
      ? lumaConnectionForInstance(
          connections.data?.connections ?? [],
          scope.presentationInstanceId,
          boundSource,
        )
      : undefined;
  const snapshot = useEnvironmentQuery(
    connection === undefined || environment === null || scope.phase !== "ready"
      ? null
      : serverEnvironment.lumaConfiguration({
          environmentId: environment.environmentId,
          input: { connectionId: connection.connectionId, instanceId: connection.instanceId },
        }),
  );
  const refreshConnections = connections.refresh;
  const refreshSnapshot = snapshot.refresh;
  const retry = useCallback(() => {
    refreshConnections();
    refreshSnapshot();
  }, [refreshConnections, refreshSnapshot]);
  const liveReady = scope.phase === "ready" && connection !== undefined && snapshot.data !== null;
  const liveConfiguration = liveReady ? (snapshot.data?.configuration ?? null) : null;
  const liveTarget = connection
    ? { connectionId: connection.connectionId, instanceId: connection.instanceId }
    : null;
  const liveInstanceId = scope.presentationInstanceId;
  const liveInstanceName = connection?.displayName ?? null;
  useEffect(() => {
    if (!liveReady || liveInstanceId === null || liveTarget === null) return;
    writeCachedSupervisorLumas(liveInstanceId, {
      instanceName: liveInstanceName,
      target: liveTarget,
      configuration: liveConfiguration,
    });
  }, [liveReady, liveInstanceId, liveInstanceName, liveTarget, liveConfiguration]);
  const cached = useMemo(
    () => readCachedSupervisorLumas(liveInstanceId),
    // Bei jedem erfolgreichen Live-Abruf neu einlesen, damit die Anzeige sofort folgt.
    [liveInstanceId, liveReady, snapshot.data],
  );
  const phase =
    scope.phase === "resolving" || connections.isPending || snapshot.isPending
      ? "loading"
      : liveReady
        ? "ready"
        : "unavailable";
  if (!liveReady && cached !== null) {
    return {
      instanceId: liveInstanceId,
      instanceName: cached.instanceName,
      target: cached.target,
      phase: "ready",
      profiles: cached.configuration?.workerProfiles ?? [],
      configuration: cached.configuration,
      retry,
    };
  }
  return {
    instanceId: liveInstanceId,
    instanceName: liveInstanceName,
    target: liveTarget,
    phase,
    profiles: liveReady ? (liveConfiguration?.workerProfiles ?? []) : [],
    configuration: liveConfiguration,
    retry,
  };
}

export function ProjectSupervisorLumaField(props: LumaFieldProps) {
  return <ProjectSupervisorLumaSelect {...props} {...useProjectSupervisorLumas()} />;
}

export function ProjectSupervisorLumaSummary({ lumaId }: { readonly lumaId: string }) {
  return <ProjectSupervisorLumaSummaryView lumaId={lumaId} {...useProjectSupervisorLumas()} />;
}

export function ProjectSupervisorLumaSummaryView({
  lumaId,
  phase,
  profiles,
}: {
  readonly lumaId: string;
  readonly phase: "loading" | "ready" | "unavailable";
  readonly profiles: readonly WorkjetWorkerProfile[];
}) {
  const selected =
    phase === "ready" ? profiles.find((profile) => profile.id === lumaId) : undefined;
  return (
    <span title={selected?.computerId}>
      {selected
        ? `Konfiguriert · ${workjetHarnessDisplayLabel(selected.harness)} · ${selected.modelId}`
        : phase === "loading"
          ? ""
          : "Presets nicht erreichbar"}
    </span>
  );
}

export function ProjectSupervisorLumaSelect({
  id,
  value,
  onChange,
  disabled,
  phase,
  profiles,
  retry,
}: LumaFieldProps & {
  readonly phase: "loading" | "ready" | "unavailable";
  readonly profiles: readonly WorkjetWorkerProfile[];
  /** Ohne Wiederholung bleibt nur die Fehlerzeile. */
  readonly retry?: (() => void) | undefined;
}) {
  const selected = profiles.find((profile) => profile.id === value);
  const loadingSlow = useLoadingEndsAfter10s(phase);
  return (
    <div className="grid min-w-0 gap-1">
      <OptionSelect
        id={id}
        aria-label="Supervisor-Preset"
        className="w-auto"
        value={value ?? ""}
        disabled={disabled || phase !== "ready"}
        options={[
          { value: "", label: "Instanz-Standard" },
          ...(value !== null && selected === undefined
            ? [{ value, label: "Gespeichertes Preset" }]
            : []),
          ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
        ]}
        onValueChange={(next) => onChange(next || null)}
      />
      {phase === "unavailable" || loadingSlow ? (
        <PresetsUnavailableLine retry={retry} />
      ) : (
        <span className="break-words text-xs text-muted-foreground" role="status">
          {phase === "loading"
            ? ""
            : selected
              ? `${workjetHarnessDisplayLabel(selected.harness)} · ${selected.modelId}`
              : value !== null
                ? "Preset fehlt in dieser Instanz"
                : ""}
        </span>
      )}
    </div>
  );
}

/** Fehlerzeile „Presets nicht erreichbar“ mit genau einer Aktion. */
export function PresetsUnavailableLine({ retry }: { readonly retry?: (() => void) | undefined }) {
  return (
    <div role="alert" className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
      <span className="text-destructive-foreground">Presets nicht erreichbar</span>
      {retry ? (
        <Button type="button" size="xs" variant="outline" onClick={retry}>
          Erneut versuchen
        </Button>
      ) : null}
    </div>
  );
}

/** Ein Laden endet nach 10 s (UI-Vertrag §1.3): danach gilt es als nicht erreichbar. */
export function useLoadingEndsAfter10s(phase: "loading" | "ready" | "unavailable"): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (phase !== "loading") {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [phase]);
  return slow;
}
