// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  BusinessOsInstanceId,
  EnvironmentId,
  WorkjetBusinessOsComputerOwnershipError,
  WorkjetHostIdentityId,
  type WorkjetBusinessOsComputerAssignmentAuthority,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  WorkjetBusinessOsComputerAuthorityResolver,
  WorkjetBusinessOsComputerOwnershipStore,
  WorkjetBusinessOsComputerOwnershipStoreLive,
  type WorkjetBusinessOsComputerAuthorityResolverShape,
} from "./WorkjetBusinessOsComputerOwnershipStore.ts";

const WELSCH = BusinessOsInstanceId.make("business-os-welsch");
const NORTH = BusinessOsInstanceId.make("business-os-north");
const MANAGED = BusinessOsInstanceId.make("business-os-managed");
const AMBIGUOUS = BusinessOsInstanceId.make("business-os-ambiguous");

const environment = (value: string) => EnvironmentId.make(value);
const host = (value: string) => WorkjetHostIdentityId.make(value);

const authorityResolver: WorkjetBusinessOsComputerAuthorityResolverShape = {
  resolve: ({ businessOsInstanceId, environmentId }) => {
    const common = {
      businessOsInstanceId,
      computerEnvironmentId: environmentId,
    } as const;

    if (businessOsInstanceId === AMBIGUOUS) {
      return Effect.succeed({
        ...common,
        hostingMode: "self-hosted",
        backendEnvironmentId: null,
        backendHostIdentityId: null,
        computerHostIdentityId: null,
      } satisfies WorkjetBusinessOsComputerAssignmentAuthority);
    }

    if (businessOsInstanceId === MANAGED) {
      return Effect.succeed({
        ...common,
        hostingMode: "managed",
        backendEnvironmentId: environment("managed-backend"),
        backendHostIdentityId: host("managed-host"),
        computerHostIdentityId:
          environmentId === environment("managed-backend") ||
          environmentId === environment("managed-host-alias")
            ? host("managed-host")
            : host(`host-${environmentId}`),
      } satisfies WorkjetBusinessOsComputerAssignmentAuthority);
    }

    const backendEnvironmentId =
      businessOsInstanceId === WELSCH
        ? environment("welsch-backend")
        : environment("north-backend");
    const backendHostIdentityId =
      businessOsInstanceId === WELSCH ? host("welsch-host") : host("north-host");
    return Effect.succeed({
      ...common,
      hostingMode: "self-hosted",
      backendEnvironmentId,
      backendHostIdentityId,
      computerHostIdentityId:
        environmentId === backendEnvironmentId || environmentId === environment("welsch-host-alias")
          ? backendHostIdentityId
          : host(`host-${environmentId}`),
    } satisfies WorkjetBusinessOsComputerAssignmentAuthority);
  },
};

const resolverLayer = Layer.succeed(WorkjetBusinessOsComputerAuthorityResolver, authorityResolver);
const testLayer = WorkjetBusinessOsComputerOwnershipStoreLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(resolverLayer),
);

const isOwnershipError = Schema.is(WorkjetBusinessOsComputerOwnershipError);

it.effect("stores one-to-many ownership and lists an instance's computers", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetBusinessOsComputerOwnershipStore;
    yield* store.assign({ businessOsInstanceId: WELSCH, environmentId: environment("gpu-1") });
    yield* store.assign({ businessOsInstanceId: WELSCH, environmentId: environment("gpu-3") });

    const assignments = yield* store.listByInstance(WELSCH);
    assert.deepEqual(
      assignments.map((assignment) => assignment.environmentId),
      [environment("gpu-1"), environment("gpu-3")],
    );
    assert.isTrue(assignments.every((assignment) => assignment.coLocationRiskAcceptance === null));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("atomically replaces an environment's sole owner and reports the previous instance", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetBusinessOsComputerOwnershipStore;
    const gpu = environment("gpu-move");

    const first = yield* store.assign({ businessOsInstanceId: WELSCH, environmentId: gpu });
    assert.equal(first.previousBusinessOsInstanceId, null);

    const moved = yield* store.assign({ businessOsInstanceId: NORTH, environmentId: gpu });
    assert.equal(moved.previousBusinessOsInstanceId, WELSCH);
    assert.equal(moved.assignment.businessOsInstanceId, NORTH);

    assert.deepEqual(yield* store.listByInstance(WELSCH), []);
    assert.equal((yield* store.listByInstance(NORTH)).length, 1);
    assert.equal(Option.getOrThrow(yield* store.getByEnvironment(gpu)).businessOsInstanceId, NORTH);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("always rejects the managed backend environment even with risk confirmation", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetBusinessOsComputerOwnershipStore;
    const result = yield* store
      .assign({
        businessOsInstanceId: MANAGED,
        environmentId: environment("managed-backend"),
        coLocationRiskConfirmation: { policyVersion: 1, confirmed: true },
      })
      .pipe(Effect.result);

    assert.equal(result._tag, "Failure");
    if (result._tag !== "Failure") return;
    assert.isTrue(isOwnershipError(result.failure));
    if (isOwnershipError(result.failure)) {
      assert.equal(result.failure.reason, "managed-backend-host");
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "also rejects a managed backend reached through another environment id on the same host",
  () =>
    Effect.gen(function* () {
      const store = yield* WorkjetBusinessOsComputerOwnershipStore;
      const result = yield* store
        .assign({
          businessOsInstanceId: MANAGED,
          environmentId: environment("managed-host-alias"),
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure" && isOwnershipError(result.failure)) {
        assert.equal(result.failure.reason, "managed-backend-host");
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect("requires and persists explicit v1 risk acceptance for self-hosted co-location", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetBusinessOsComputerOwnershipStore;
    const local = environment("welsch-host-alias");

    const refused = yield* store
      .assign({ businessOsInstanceId: WELSCH, environmentId: local })
      .pipe(Effect.result);
    assert.equal(refused._tag, "Failure");
    if (refused._tag === "Failure" && isOwnershipError(refused.failure)) {
      assert.equal(refused.failure.reason, "colocation-confirmation-required");
    }

    const accepted = yield* store.assign({
      businessOsInstanceId: WELSCH,
      environmentId: local,
      coLocationRiskConfirmation: { policyVersion: 1, confirmed: true },
    });
    assert.equal(accepted.assignment.coLocationRiskAcceptance?.policyVersion, 1);
    assert.equal(
      accepted.assignment.coLocationRiskAcceptance?.confirmedAtMillis,
      accepted.assignment.assignedAtMillis,
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "allows separately provisioned external computers for managed and self-hosted instances",
  () =>
    Effect.gen(function* () {
      const store = yield* WorkjetBusinessOsComputerOwnershipStore;
      const managedExternal = yield* store.assign({
        businessOsInstanceId: MANAGED,
        environmentId: environment("managed-gpu-external"),
        // Irrelevant confirmation never becomes durable evidence.
        coLocationRiskConfirmation: { policyVersion: 1, confirmed: true },
      });
      const selfHostedExternal = yield* store.assign({
        businessOsInstanceId: WELSCH,
        environmentId: environment("self-hosted-gpu-external"),
      });

      assert.equal(managedExternal.assignment.coLocationRiskAcceptance, null);
      assert.equal(selfHostedExternal.assignment.coLocationRiskAcceptance, null);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("fails closed when neither backend environment nor physical host identity is known", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetBusinessOsComputerOwnershipStore;
    const result = yield* store
      .assign({
        businessOsInstanceId: AMBIGUOUS,
        environmentId: environment("possibly-local"),
        coLocationRiskConfirmation: { policyVersion: 1, confirmed: true },
      })
      .pipe(Effect.result);

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure" && isOwnershipError(result.failure)) {
      assert.equal(result.failure.reason, "authority-unavailable");
    }
  }).pipe(Effect.provide(testLayer)),
);
