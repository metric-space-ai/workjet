import {
  WorkjetWorkerProfileId,
  WorkjetLlmRouteId,
  type CtoxWorkjetProjectProjection,
  type WorkjetComputer,
  type WorkjetGatewayModelSummary,
  type WorkjetHarness,
  type WorkjetLumaSnapshot,
  type WorkjetWorkerProfile,
} from "@workjet/contracts";
import type { NativeSupervisorScope } from "./nativeSupervisorComposer";
import { saveSupervisorLuma } from "./workjetSupervisorLuma";
import { listWorkjetProjects, type WorkjetProjectControlPort } from "./workjetProjectControl";
import { newCommandId, randomUUID } from "./lib/utils";

type InstanceConfiguration = NonNullable<WorkjetLumaSnapshot["configuration"]>;

export function isSupervisorManualProfile(
  profile: Pick<WorkjetWorkerProfile, "id">,
  projectId: string,
): boolean {
  return profile.id.startsWith(`supervisor-manual:${projectId}:`);
}

export type SupervisorManualSelection = Pick<
  WorkjetWorkerProfile,
  "harness" | "modelId" | "computerId"
>;

/** An advertised account can supply a missing route; account identities come from the catalog. */
export function prepareSupervisorManualChoice(
  input: Parameters<typeof prepareSupervisorManualProfile>[0],
) {
  let configuration = input.configuration;
  const template = configuration.workerProfiles.find(
    (profile) => profile.modelId === input.selection.modelId,
  );
  const model = input.models.find((entry) => entry.id === input.selection.modelId);
  const hasRoute = configuration.llmRoutes.some(
    (route) =>
      route.id === template?.llmRouteId ||
      (route.gatewayAccountId !== undefined && model?.accountIds.includes(route.gatewayAccountId)),
  );
  if (!hasRoute && model?.accountIds[0]) {
    configuration = {
      ...configuration,
      llmRoutes: [
        ...configuration.llmRoutes,
        {
          id: WorkjetLlmRouteId.make(randomUUID()),
          label: model.displayName,
          gatewayAccountId: model.accountIds[0],
        },
      ],
    };
  }
  return { configuration, profile: prepareSupervisorManualProfile({ ...input, configuration }) };
}

/** Manual is an instance-owned route, scoped to one project and immutable once selected. */
export function prepareSupervisorManualProfile(input: {
  readonly projectId: string;
  readonly selection: SupervisorManualSelection;
  readonly configuration: InstanceConfiguration;
  readonly computers: readonly WorkjetComputer[];
  readonly models: readonly WorkjetGatewayModelSummary[];
}): WorkjetWorkerProfile {
  const { selection, configuration } = input;
  const computer = input.computers.find((entry) => entry.id === selection.computerId);
  if (!computer) throw new Error("The selected computer is not available in this instance.");
  const template = configuration.workerProfiles.find(
    (profile) => profile.modelId === selection.modelId,
  );
  if (
    !computer.harnesses.some((entry) => entry.harness === selection.harness && entry.available) &&
    !configuration.workerProfiles.some(
      (profile) => profile.computerId === computer.id && profile.harness === selection.harness,
    )
  )
    throw new Error(
      `${computer.label} cannot run ${selection.harness}. Configure its harness in Settings.`,
    );
  const model = input.models.find((entry) => entry.id === selection.modelId);
  const route =
    configuration.llmRoutes.find((entry) => entry.id === template?.llmRouteId) ??
    configuration.llmRoutes.find(
      (entry) =>
        entry.gatewayAccountId !== undefined && model?.accountIds.includes(entry.gatewayAccountId),
    );
  if (!route) throw new Error("No configured account route can run this model on the instance.");
  if (!template && !model) throw new Error("This model is not in the available instance catalog.");
  const previous = configuration.workerProfiles.find(
    (profile) =>
      isSupervisorManualProfile(profile, input.projectId) &&
      profile.harness === selection.harness &&
      profile.modelId === selection.modelId &&
      profile.computerId === selection.computerId &&
      profile.llmRouteId === route.id,
  );
  if (previous) return previous;
  return {
    reasoning: "automatic",
    role: "standard",
    capabilityIds: [],
    capabilityBindings: [],
    ...selection,
    id: WorkjetWorkerProfileId.make(`supervisor-manual:${input.projectId}:${randomUUID()}`),
    name: "Manual",
    llmRouteId: route.id,
  };
}

export async function persistSupervisorComposerSelection(input: {
  readonly scope: NativeSupervisorScope;
  readonly project: CtoxWorkjetProjectProjection;
  readonly profile: WorkjetWorkerProfile;
  readonly snapshot: WorkjetLumaSnapshot;
  readonly writeConfiguration: (
    configuration: InstanceConfiguration,
    expectedRevision: number,
  ) => Promise<"saved" | "conflict">;
  readonly readConfiguration: () => Promise<WorkjetLumaSnapshot>;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly port?: WorkjetProjectControlPort;
}): Promise<CtoxWorkjetProjectProjection> {
  const current = () => !input.signal.aborted && input.isCurrent();
  if (!current()) throw new Error("The project selection changed.");
  const configuration = input.snapshot.configuration;
  if (!configuration) throw new Error("The instance Luma configuration has not loaded.");
  const exists = configuration.workerProfiles.some((entry) => entry.id === input.profile.id);
  if (input.snapshot.revision === 0 || !exists) {
    const status = await input.writeConfiguration(
      {
        ...configuration,
        workerProfiles: exists
          ? configuration.workerProfiles
          : [...configuration.workerProfiles, input.profile],
      },
      input.snapshot.revision,
    );
    if (!current()) throw new Error("The project selection changed.");
    if (status !== "saved") throw new Error("The instance configuration changed. Choose again.");
  }
  const confirmed = await input.readConfiguration();
  if (!current()) throw new Error("The project selection changed.");
  const profile = confirmed.configuration?.workerProfiles.find(
    (entry) => entry.id === input.profile.id,
  );
  const expectedRoute = configuration.llmRoutes.find(
    (route) => route.id === input.profile.llmRouteId,
  );
  const confirmedRoute = confirmed.configuration?.llmRoutes.find(
    (route) => route.id === input.profile.llmRouteId,
  );
  if (
    !expectedRoute ||
    !confirmedRoute ||
    expectedRoute.gatewayAccountId !== confirmedRoute.gatewayAccountId ||
    JSON.stringify(expectedRoute.nativeAccountReference) !==
      JSON.stringify(confirmedRoute.nativeAccountReference)
  )
    throw new Error("The instance did not confirm the selected model’s account route.");
  if (
    !profile ||
    profile.harness !== input.profile.harness ||
    profile.modelId !== input.profile.modelId ||
    profile.computerId !== input.profile.computerId ||
    profile.llmRouteId !== input.profile.llmRouteId
  )
    throw new Error("The instance did not confirm the selected harness, model and computer.");
  const result = await saveSupervisorLuma({
    ...input,
    lumaId: profile.id,
    commandId: newCommandId(),
  });
  if (result.phase !== "saved")
    throw new Error(result.phase === "failed" ? result.error : "The project selection changed.");
  const listed = await listWorkjetProjects(input.scope.instanceId, input.port);
  if (!current()) throw new Error("The project selection changed.");
  const project =
    listed._tag === "completed" && listed.response.action === "project.list"
      ? listed.response.projects.find((entry) => entry.id === input.scope.projectId)
      : undefined;
  if (!project || project.supervisorLumaId !== profile.id)
    throw new Error(
      "The instance did not retain the Supervisor selection. Reconnect to read its route.",
    );
  return project;
}

/** A harness switch uses a configured model; it never guesses a model identifier. */
export function supervisorSelectionForHarness(
  harness: WorkjetHarness,
  selected: WorkjetWorkerProfile | null,
  profiles: readonly WorkjetWorkerProfile[],
  computerId: WorkjetComputer["id"] | null,
): SupervisorManualSelection {
  const candidate =
    selected ??
    profiles.find((entry) => entry.harness === harness && entry.computerId === computerId) ??
    profiles.find((entry) => entry.harness === harness) ??
    profiles.find((entry) => entry.computerId === computerId);
  if (!candidate) throw new Error("No model is configured for this harness on the instance.");
  return {
    harness,
    modelId: candidate.modelId,
    computerId: selected?.computerId ?? computerId ?? candidate.computerId,
  };
}
