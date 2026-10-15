import { assert, it } from "@effect/vitest";
it.effect(
  "capability edits reuse the issued computer instead of changing immutable enrollment intent",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const service = yield* f.make;
      yield* service.enroll(input);
      const edited = yield* service.enroll({
        ...input,
        computerId: nativeId,
        displayName: "GPU3 renamed",
        buildCapability: { ...input.buildCapability, slots: 2 },
      });
      assert.equal(edited.computerId, nativeId);
      assert.equal(f.calls(), 1);
      assert.equal(f.getSettings().workjet.computers[0]?.label, "GPU3 renamed");
    }),
);
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  WorkjetComputerId,
  WorkjetConnectionId,
  WorkjetWorkerProfile,
  type RemoteWorkerComputerEnrollmentInput,
  type ServerSettings,
  type WorkjetConnectionSummary,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { makeRemoteWorkerComputerEnrollment } from "./RemoteWorkerComputerEnrollment.ts";
import type {
  RemoteWorkerNativeTargetReceipt,
  makeCtoxRemoteWorkerTargets,
} from "./ctox/CtoxRemoteWorkerTargets.ts";
const source = EnvironmentId.make("source");
const target = EnvironmentId.make("gpu3");
const draftId = WorkjetComputerId.make("draft");
const nativeId = WorkjetComputerId.make("native-opaque");
const connectionId = WorkjetConnectionId.make("business-os-grant");
const input: RemoteWorkerComputerEnrollmentInput = {
  selectedInstanceId: "selected-bo",
  computerId: draftId,
  displayName: "GPU worker",
  hostingMode: "self_hosted",
  profile: {
    connectionId: "desktop-ssh-profile",
    environmentId: target,
    target: { alias: "gpu3", hostname: "gpu3", port: 22, username: "worker" },
  },
  buildCapability: {
    kind: "build",
    ssh_endpoint_ref: "endpoint-ref",
    slots: 3,
    jobs: 6,
    lane_root: "/build/lane",
    disk_floor_gib: 40,
    toolchains: ["rust-stable", "node"],
  },
};
const ready: WorkjetConnectionSummary = {
  connectionId,
  instanceId: "selected-bo",
  displayName: "BO",
  source: "local_ctox",
  status: "ready",
  reason: null,
};
const fixture = (entries: ReadonlyArray<WorkjetConnectionSummary> = [ready]) => {
  let settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    workjet: {
      ...DEFAULT_SERVER_SETTINGS.workjet,
      computers: [
        {
          id: draftId,
          label: "Draft",
          environmentId: target,
          presentationKind: "ssh",
          harnesses: [],
        },
      ],
      selectedComputerId: draftId,
      workerProfiles: [
        Schema.decodeSync(WorkjetWorkerProfile)({
          id: "worker",
          name: "Worker",
          computerId: draftId,
          harness: "codex-cli",
          llmRouteId: "route",
          modelId: "model",
          reasoning: "automatic",
        }),
      ],
    },
  };
  let calls = 0;
  let issued: RemoteWorkerNativeTargetReceipt | undefined;
  const secrets = new Map<string, Uint8Array>();
  const enroll: ReturnType<typeof makeCtoxRemoteWorkerTargets>["enroll"] = (
    scope,
    from,
    to,
    assignment,
    computer,
  ) =>
    Effect.sync(() => {
      calls++;
      assert.equal(scope.connectionId, connectionId);
      assert.deepEqual(assignment, {
        targetConnectionId: connectionId,
        targetInstanceId: "selected-bo",
      });
      assert.deepEqual(computer.buildCapability, input.buildCapability);
      return (issued = {
        contract: "ctox.workjet.remote-worker-target.v1" as const,
        bindingId: "binding",
        revision: 1,
        ownerUserId: "owner",
        sourceInstanceId: scope.instanceId,
        target: {
          sourceEnvironmentId: from,
          targetEnvironmentId: to,
          ...assignment,
          targetComputerId: nativeId,
        },
        state: "active" as const,
        capabilityEpoch: 1,
        buildCapability: input.buildCapability,
      });
    });
  return {
    make: makeRemoteWorkerComputerEnrollment({
      environmentId: source,
      connections: {
        list: Effect.succeed(entries),
        resolveReadyTarget: () =>
          Effect.succeed({ endpoint: "http://127.0.0.1:8080/mcp", token: "fixture-token" }),
      },
      targets: {
        enroll,
        resolve: () =>
          Effect.sync(() => {
            assert.ok(issued);
            return issued;
          }),
        register: () => Effect.never,
        revoke: () => Effect.never,
      },
      secrets: {
        remove: (key) =>
          Effect.sync(() => {
            secrets.delete(key);
          }),
        get: (key) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(key))),
        set: (key, bytes) =>
          Effect.sync(() => {
            secrets.set(key, bytes);
          }),
      },
      settings: {
        getSettings: Effect.sync(() => settings),
        updateSettings: (patch) =>
          Effect.sync(() => {
            settings = { ...settings, ...patch } as ServerSettings;
            return settings;
          }),
      },
    }),
    getSettings: () => settings,
    calls: () => calls,
  };
};
it.effect(
  "fails closed for absent, foreign or ambiguous selected Business OS grants before native enrollment",
  () =>
    Effect.gen(function* () {
      for (const entries of [[], [{ ...ready, instanceId: "foreign" }], [ready, ready]]) {
        const f = fixture(entries);
        const service = yield* f.make;
        yield* Effect.flip(service.enroll(input));
        assert.equal(f.calls(), 0);
      }
    }),
);

it.effect(
  "uses the explicitly selected source grant when another grant has the same native pin",
  () =>
    Effect.gen(function* () {
      const other = { ...ready, connectionId: WorkjetConnectionId.make("other-grant") };
      const f = fixture([other, ready]);
      const service = yield* f.make;
      const result = yield* service.enroll({ ...input, sourceConnectionId: connectionId });
      assert.equal(result.computerId, nativeId);
      assert.equal(f.calls(), 1);
    }),
);

it.effect("rejects an unknown or foreign explicit source grant before native enrollment", () =>
  Effect.gen(function* () {
    for (const entries of [[ready], [{ ...ready, instanceId: "foreign" }]]) {
      const f = fixture(entries);
      const service = yield* f.make;
      yield* Effect.flip(
        service.enroll({
          ...input,
          sourceConnectionId:
            entries[0]!.instanceId === "foreign"
              ? connectionId
              : WorkjetConnectionId.make("unknown-grant"),
        }),
      );
      assert.equal(f.calls(), 0);
    }
  }),
);

it.effect(
  "retains the issued ID and all configuration links before ACK and after a lost ACK retry",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const service = yield* f.make;
      const first = yield* service.enroll(input);
      assert.equal(first.computerId, nativeId);
      assert.equal(f.getSettings().workjet.computers[0]?.id, nativeId);
      assert.equal(f.getSettings().workjet.selectedComputerId, nativeId);
      assert.equal(f.getSettings().workjet.workerProfiles[0]?.computerId, nativeId);
      assert.deepEqual(yield* service.enroll(input), first);
      assert.equal(f.calls(), 1);
      yield* Effect.flip(
        service.enroll({
          ...input,
          profile: { ...input.profile, target: { ...input.profile.target, hostname: "changed" } },
        }),
      );
      assert.equal(f.calls(), 1);
      yield* service.verifyRegisteredProfile(
        nativeId,
        { connectionId, instanceId: "selected-bo" },
        input.profile,
      );
      yield* Effect.flip(
        service.verifyRegisteredProfile(
          nativeId,
          { connectionId, instanceId: "foreign-bo" },
          input.profile,
        ),
      );
      yield* Effect.flip(
        service.verifyRegisteredProfile(
          nativeId,
          { connectionId, instanceId: "selected-bo" },
          { ...input.profile, target: { ...input.profile.target, hostname: "changed-host" } },
        ),
      );
    }),
);
