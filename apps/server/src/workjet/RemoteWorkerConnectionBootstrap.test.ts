// @effect-diagnostics globalDate:off -- Fixture expiry tracks the wall clock used by the real Node port-reservation boundary.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkjetComputerId,
  type RemoteWorkerRequest,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { make, verifyLinuxWorkerLoopback } from "./RemoteWorkerConnectionBootstrap.ts";
import { RemoteWorkerBroker } from "./RemoteWorkerBroker.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

const request: RemoteWorkerRequest = {
  schemaVersion: 1,
  requestId: ThreadId.make("worker-one"),
  targetEnvironmentId: EnvironmentId.make("gpu3"),
  computerId: WorkjetComputerId.make("gpu3"),
  parent: { environmentId: EnvironmentId.make("source"), threadId: ThreadId.make("supervisor") },
  parentCapabilityIds: [],
  enabledCapabilityIds: [],
  managedInstructions: "One PR",
  revision: "a".repeat(40),
  project: {
    id: ProjectId.make("project"),
    title: "Project",
    repository: {
      canonicalKey: "github:example/project",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/project.git",
      },
    },
  },
  task: "Fix issue",
  title: "Issue",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const secrets = ServerSecretStore.of({
  get: () => Effect.succeed(Option.none()),
  set: () => Effect.void,
  create: () => Effect.void,
  remove: () => Effect.void,
  getOrCreateRandom: () => Effect.die("No secret generation should be needed"),
});
const broker = RemoteWorkerBroker.of({
  enqueue: () => Effect.void,
  read: () => Effect.succeed(Option.none()),
  respond: () => Effect.succeed(undefined),
  awaitResponse: () => Effect.never,
  requests: Stream.empty,
});

it("rejects GatewayPorts wildcard and IPv6 listeners even when a loopback listener also exists", () => {
  const header = "sl local_address rem_address st\n";
  const loopback = "0: 0100007F:9C40 00000000:0000 0A\n";
  const wildcard = "1: 00000000:9C40 00000000:0000 0A\n";
  assert.equal(verifyLinuxWorkerLoopback(40000, header + loopback, header), true);
  assert.equal(verifyLinuxWorkerLoopback(40000, header + wildcard, header), false);
  assert.equal(verifyLinuxWorkerLoopback(40000, header + loopback + wildcard, header), false);
  assert.equal(
    verifyLinuxWorkerLoopback(
      40000,
      header + loopback,
      header +
        "0: 00000000000000000000000000000000:9C40 00000000000000000000000000000000:0000 0A\n",
    ),
    false,
  );
  assert.equal(verifyLinuxWorkerLoopback(40000, header, header), false);
});

it.live(
  "reserves one pinned target port and preserves it after a lost reserve acknowledgement",
  () =>
    Effect.gen(function* () {
      const service = yield* make;
      const first = yield* service.reserve(request);
      assert.deepEqual(yield* service.reserve(request), first);
      assert.equal(first.targetEnvironmentId, request.targetEnvironmentId);
      assert.equal(first.requestId, request.requestId);
      yield* Effect.flip(
        service.reserve({ ...request, targetEnvironmentId: EnvironmentId.make("foreign") }),
      );
      yield* Effect.flip(service.reserve({ ...request, task: "Changed task" }));
      const error = yield* Effect.flip(
        service.prepare({
          workerRequest: request,
          profile: {
            connectionId: "source-profile",
            environmentId: request.targetEnvironmentId,
            target: { alias: "gpu3", hostname: "gpu3", username: "worker", port: 22 },
          },
          reservation: first,
        }),
      );
      assert.equal(error.reason, "source-unavailable");
    }).pipe(
      Effect.scoped,
      Effect.provideService(
        ServerEnvironment,
        ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(request.targetEnvironmentId),
          getDescriptor: Effect.never,
        }),
      ),
      Effect.provideService(RemoteWorkerBroker, broker),
      Effect.provideService(ServerSecretStore, secrets),
      Effect.provide(NodeServices.layer),
    ),
);
