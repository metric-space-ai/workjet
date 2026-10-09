import type { WorkjetWorkerProfile } from "@workjet/contracts";
import { useBusinessOsCodeScope } from "../businessOsCodeScope";
import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { ctoxConnectionMatchesSelectedInstance } from "../workjetCtoxConnections";
import { workjetHarnessDisplayLabel } from "./settings/WorkjetWorkerEditor";

export type LumaFieldProps = {
  readonly id: string;
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
  readonly disabled: boolean;
};

/** The local server is only transport; profiles belong to the selected native instance. */
export function ProjectSupervisorLumaField(props: LumaFieldProps) {
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
  const matches =
    scope.phase === "ready"
      ? (connections.data?.connections ?? []).filter(
          (connection) =>
            connection.status === "ready" &&
            ctoxConnectionMatchesSelectedInstance(connection, scope.presentationInstanceId),
        )
      : [];
  const connection =
    matches.length === 1
      ? matches[0]
      : matches.find(
          (entry) =>
            entry.connectionId ===
            `ctox-dev:${scope.presentationInstanceId?.replace(/^managed:/, "")}`,
        );
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
  return (
    <ProjectSupervisorLumaSelect
      {...props}
      phase={phase}
      profiles={phase === "ready" ? (snapshot.data?.configuration?.workerProfiles ?? []) : []}
    />
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
        <option value="">Current instance default</option>
        {value !== null && selected === undefined && (
          <option value={value}>Saved Luma unavailable · {value}</option>
        )}
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      <span className="break-words text-xs text-muted-foreground" role="status">
        {phase === "loading"
          ? "Loading instance Lumas…"
          : phase === "unavailable"
            ? "Instance Lumas are unavailable. The saved selection is retained."
            : selected
              ? `Configured · ${workjetHarnessDisplayLabel(selected.harness)} · ${selected.modelId} · ${selected.computerId}`
              : value !== null
                ? "The saved Luma is not in this instance’s current configuration."
                : "Uses the existing instance default. Choose a Luma in Settings to configure its route."}
      </span>
    </div>
  );
}
