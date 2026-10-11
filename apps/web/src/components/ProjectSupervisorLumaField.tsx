import type { WorkjetWorkerProfile, WorkjetLumaTarget } from "@workjet/contracts";
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
  const phase =
    scope.phase === "resolving" || connections.isPending || snapshot.isPending
      ? "loading"
      : scope.phase === "ready" && connection !== undefined && snapshot.data !== null
        ? "ready"
        : "unavailable";
  return {
    instanceId: scope.presentationInstanceId,
    instanceName: connection?.displayName ?? null,
    target: connection
      ? { connectionId: connection.connectionId, instanceId: connection.instanceId }
      : null,
    phase,
    profiles: phase === "ready" ? (snapshot.data?.configuration?.workerProfiles ?? []) : [],
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
          ? "Luma wird geladen …"
          : "Luma nicht verfügbar"}
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
}: LumaFieldProps & {
  readonly phase: "loading" | "ready" | "unavailable";
  readonly profiles: readonly WorkjetWorkerProfile[];
}) {
  const selected = profiles.find((profile) => profile.id === value);
  return (
    <div className="grid min-w-0 gap-1">
      <select
        id={id}
        aria-label="Supervisor Luma"
        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
        value={value ?? ""}
        disabled={disabled || phase !== "ready"}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Instanz-Standard</option>
        {value !== null && selected === undefined && (
          <option value={value}>Gespeicherte Luma fehlt · {value}</option>
        )}
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      <span className="break-words text-xs text-muted-foreground" role="status">
        {phase === "loading"
          ? "Lumas werden geladen …"
          : phase === "unavailable"
            ? "Lumas nicht verfügbar · Auswahl bleibt"
            : selected
              ? `Konfiguriert · ${workjetHarnessDisplayLabel(selected.harness)} · ${selected.modelId} · ${selected.computerId}`
              : value !== null
                ? "Luma fehlt in dieser Instanz"
                : "Instanz-Standard"}
      </span>
    </div>
  );
}
