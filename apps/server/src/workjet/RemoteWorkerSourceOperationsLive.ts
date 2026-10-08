// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  RemoteWorkerDispatchError,
  WorkjetGatewayAdmissionInput,
  WorkjetGatewayInferenceInput,
  WorkjetComputerId,
  WorkjetConnectionId,
  type RemoteWorkerRequest,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderGatewayService } from "../providerGateway/ProviderGatewayService.ts";
import { makeManagedSourceGatewayInference } from "../providerGateway/ManagedSourceGatewayInference.ts";
import { CtoxThreadBindingSource } from "./ctox/CtoxThreadBinding.ts";
import { DecisionHubConnectionRegistry } from "./decisionHub/DecisionHubConnectionRegistry.ts";
import { makeCtoxMcpTransport } from "./ctox/CtoxMcpTransport.ts";
import {
  makeCtoxRemoteWorkerAdmissionClient,
  remoteWorkerRequestDigest,
} from "./ctox/CtoxRemoteWorkerAdmission.ts";
import { makeCtoxRemoteWorkerTargets } from "./ctox/CtoxRemoteWorkerTargets.ts";
import { RemoteWorkerAuthorityStore } from "./RemoteWorkerAuthorityStore.ts";
import { makeRemoteWorkerSourceAuthority } from "./RemoteWorkerSourceAuthority.ts";
import { RemoteWorkerSourceOperations } from "./RemoteWorkerConnectionBootstrap.ts";
import { RemoteWorkerComputerEnrollment } from "./RemoteWorkerComputerEnrollment.ts";

const failure = () => new RemoteWorkerDispatchError({ reason: "computer-unavailable" });
const InferPayload = Schema.Struct({
  requestJson: Schema.String.check(Schema.isMaxLength(256 * 1024)),
});

export const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment;
  const settings = yield* ServerSettingsService;
  const query = yield* ProjectionSnapshotQuery;
  const bindings = yield* CtoxThreadBindingSource;
  const connections = yield* DecisionHubConnectionRegistry;
  const gateway = yield* ProviderGatewayService;
  const store = yield* RemoteWorkerAuthorityStore;
  const enrollment = yield* RemoteWorkerComputerEnrollment;
  const transport = makeCtoxMcpTransport(yield* HttpClient.HttpClient);
  const native = makeCtoxRemoteWorkerAdmissionClient({ connections, gateway, transport });
  const targets = makeCtoxRemoteWorkerTargets({ connections, transport });
  const authority = yield* makeRemoteWorkerSourceAuthority(store, native);
  const inference = makeManagedSourceGatewayInference({
    environmentId: environment.getEnvironmentId,
    settings,
    gateway,
    connections,
  });
  const currentSource = Effect.fn("RemoteWorkerSourceOperations.currentSource")(function* (
    request: RemoteWorkerRequest,
  ) {
    const environmentId = yield* environment.getEnvironmentId;
    const parent = Option.getOrUndefined(
      yield* query.getThreadDetailById(request.parent.threadId).pipe(Effect.mapError(failure)),
    );
    if (
      request.parent.environmentId !== environmentId ||
      !parent ||
      parent.deletedAt !== null ||
      parent.archivedAt !== null ||
      parent.projectId !== request.project.id ||
      parent.workjetConfig.role !== "orchestrator" ||
      request.enabledCapabilityIds.some(
        (id) => !parent.workjetConfig.enabledCapabilityIds.includes(id),
      )
    )
      return yield* failure();
    const config = (yield* settings.getSettings.pipe(Effect.mapError(failure))).workjet;
    const computers = config.computers.filter(
      (entry) =>
        entry.id === request.computerId && entry.environmentId === request.targetEnvironmentId,
    );
    const profiles = config.workerProfiles.filter(
      (entry) =>
        entry.id === request.workerProfileId &&
        entry.computerId === request.computerId &&
        entry.harness === "codex-cli" &&
        entry.modelId === request.modelSelection.model &&
        entry.llmRouteId === request.llmRouteId,
    );
    if (
      computers.length !== 1 ||
      profiles.length !== 1 ||
      request.enabledCapabilityIds.some((id) => !profiles[0]!.capabilityIds.includes(id))
    )
      return yield* failure();
    const source = yield* bindings.fromStartConfig(parent.workjetConfig);
    if (source.environmentId !== environmentId || source.binding === undefined)
      return yield* failure();
    return source.binding;
  });
  return RemoteWorkerSourceOperations.of({
    authorize: (request, profile) =>
      Effect.gen(function* () {
        if (profile.environmentId !== request.targetEnvironmentId) return yield* failure();
        const scope = yield* currentSource(request);
        yield* enrollment.verifyRegisteredProfile(request.computerId, scope, profile);
        const registration = yield* targets.resolve(
          scope,
          request.parent.environmentId,
          request.targetEnvironmentId,
        );
        const target = registration.target;
        if (target.targetComputerId !== request.computerId) return yield* failure();
        const selected = yield* inference
          .bindModel({
            target: {
              connectionId: WorkjetConnectionId.make(target.targetConnectionId),
              instanceId: target.targetInstanceId,
              computerId: WorkjetComputerId.make(target.targetComputerId),
            },
            modelSelection: request.modelSelection,
            ...(request.llmRouteId === undefined ? {} : { routeId: request.llmRouteId }),
          })
          .pipe(Effect.mapError(failure));
        yield* authority.prepare({
          request,
          scope,
          binding: {
            requestId: request.requestId,
            requestDigest: yield* remoteWorkerRequestDigest(request),
            sourceEnvironmentId: request.parent.environmentId,
            sourceSupervisorThreadId: request.parent.threadId,
            sourceInstanceId: scope.instanceId,
            projectId: request.project.id,
            targetEnvironmentId: request.targetEnvironmentId,
            targetConnectionId: target.targetConnectionId,
            targetInstanceId: target.targetInstanceId,
            targetComputerId: target.targetComputerId,
            repositoryUrl: request.project.repository.locator.remoteUrl,
            repositoryHead: request.revision,
            workspaceKey: request.requestId,
            credentialRef: selected.credentialRef,
            providerRef: selected.providerRef,
            modelRef: selected.modelRef,
            capabilities: [
              "repository_read",
              "repository_write",
              "run_checks",
              "open_pull_request",
            ],
          },
        });
      }).pipe(Effect.asVoid),
    invoke: (request, operation, payload, signal) =>
      Effect.runPromise(
        Effect.gen(function* () {
          if (operation === "retire") {
            yield* authority.revoke(request);
            return { retired: true };
          }
          const scope = yield* currentSource(request);
          const current = yield* authority.admit(request);
          if (
            scope.connectionId !== current.sourceConnectionId ||
            scope.instanceId !== current.permit.binding.sourceInstanceId
          )
            return yield* failure();
          if (operation === "admit") return { admitted: true };
          const binding = current.permit.binding;
          if (operation === "bindModel")
            return {
              target: {
                connectionId: binding.targetConnectionId,
                instanceId: binding.targetInstanceId,
                computerId: binding.targetComputerId,
              },
              credentialRef: binding.credentialRef,
              providerRef: binding.providerRef,
              modelRef: binding.modelRef,
            };
          const input = yield* Schema.decodeUnknownEffect(InferPayload)(payload).pipe(
            Effect.mapError(failure),
          );
          const admitted = yield* Schema.decodeUnknownEffect(WorkjetGatewayAdmissionInput)(
            current,
          ).pipe(Effect.mapError(failure));
          const inferenceInput = yield* Schema.decodeUnknownEffect(WorkjetGatewayInferenceInput)({
            ...admitted,
            requestJson: input.requestJson,
          }).pipe(Effect.mapError(failure));
          return yield* inference.infer(inferenceInput).pipe(Effect.mapError(failure));
        }),
        { signal },
      ),
  });
});
export const layer = Layer.effect(RemoteWorkerSourceOperations, make).pipe(
  Layer.provide(FetchHttpClient.layer),
);
