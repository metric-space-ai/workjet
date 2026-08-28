import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthSessionId,
  BusinessOsInstanceId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
  EnvironmentId,
  WorkjetBusinessOsComputerOwnershipError,
  WorkjetBusinessOsComputerMembershipHttpApi,
  WorkjetHostIdentityId,
  type AuthEnvironmentScope,
  type WorkjetBusinessOsComputerAssignmentAuthority,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpApiTest } from "effect/unstable/httpapi";
import { describe, expect, it } from "@effect/vitest";

import { WorkjetBusinessOsComputerOwnershipStore } from "./WorkjetBusinessOsComputerOwnershipStore.ts";
import {
  WORKJET_BUSINESS_OS_COMPUTER_RESPONSE_HEADERS,
  businessOsComputerMembershipHttpApiLayer,
} from "./http.ts";

const A = BusinessOsInstanceId.make("business-os-a");
const B = BusinessOsInstanceId.make("business-os-b");
const MANAGED = BusinessOsInstanceId.make("business-os-managed");
const environment = (value: string) => EnvironmentId.make(value);
const host = (value: string) => WorkjetHostIdentityId.make(value);

function authorityFor(
  businessOsInstanceId: typeof A,
  environmentId: ReturnType<typeof environment>,
): WorkjetBusinessOsComputerAssignmentAuthority {
  const managed = businessOsInstanceId === MANAGED;
  const backendEnvironmentId = managed
    ? environment("managed-backend")
    : environment(`${businessOsInstanceId}-backend`);
  const backendHostIdentityId = managed
    ? host("managed-host")
    : host(`${businessOsInstanceId}-host`);
  return {
    businessOsInstanceId,
    hostingMode: managed ? "managed" : "self-hosted",
    backendEnvironmentId,
    backendHostIdentityId,
    computerEnvironmentId: environmentId,
    computerHostIdentityId:
      environmentId === backendEnvironmentId
        ? backendHostIdentityId
        : host(`external-${environmentId}`),
  };
}

const authenticatedAuth = (scopes: ReadonlySet<AuthEnvironmentScope>) =>
  EnvironmentAuthenticatedAuth.of((httpEffect) =>
    httpEffect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("test-session"),
        subject: "test-client",
        method: "browser-session-cookie",
        scopes,
      }),
    ),
  );

const unauthenticatedAuth = EnvironmentAuthenticatedAuth.of(() =>
  Effect.fail(
    new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "missing_credential",
      traceId: "test-trace",
    }),
  ),
);

function clientFor(auth: typeof EnvironmentAuthenticatedAuth.Service) {
  const owners = new Map<
    string,
    {
      readonly businessOsInstanceId: typeof A;
      readonly environmentId: ReturnType<typeof environment>;
      readonly assignedAtMillis: number;
      readonly coLocationRiskAcceptance: null | {
        readonly policyVersion: 1;
        readonly confirmedAtMillis: number;
      };
    }
  >();
  const storeLayer = Layer.succeed(
    WorkjetBusinessOsComputerOwnershipStore,
    WorkjetBusinessOsComputerOwnershipStore.of({
      assign: (input) => {
        const authority = authorityFor(input.businessOsInstanceId, input.environmentId);
        const coLocated =
          authority.backendEnvironmentId === authority.computerEnvironmentId ||
          authority.backendHostIdentityId === authority.computerHostIdentityId;
        if (coLocated && authority.hostingMode === "managed") {
          return Effect.fail(
            new WorkjetBusinessOsComputerOwnershipError({ reason: "managed-backend-host" }),
          );
        }
        if (coLocated && input.coLocationRiskConfirmation?.confirmed !== true) {
          return Effect.fail(
            new WorkjetBusinessOsComputerOwnershipError({
              reason: "colocation-confirmation-required",
            }),
          );
        }
        const previousBusinessOsInstanceId =
          owners.get(input.environmentId)?.businessOsInstanceId ?? null;
        const assignment = {
          businessOsInstanceId: input.businessOsInstanceId,
          environmentId: input.environmentId,
          assignedAtMillis: 100,
          coLocationRiskAcceptance: coLocated
            ? { policyVersion: 1 as const, confirmedAtMillis: 100 }
            : null,
        };
        owners.set(input.environmentId, assignment);
        return Effect.succeed({ assignment, previousBusinessOsInstanceId });
      },
      getByEnvironment: (environmentId) =>
        Effect.succeed(
          owners.has(environmentId) ? Option.some(owners.get(environmentId)!) : Option.none(),
        ),
      listByInstance: (businessOsInstanceId) =>
        Effect.succeed(
          [...owners.values()].filter(
            (assignment) => assignment.businessOsInstanceId === businessOsInstanceId,
          ),
        ),
      listAvailable: (businessOsInstanceId) => {
        const backend =
          businessOsInstanceId === MANAGED
            ? environment("managed-backend")
            : environment(`${businessOsInstanceId}-backend`);
        return Effect.succeed(
          [backend, environment("gpu-1"), environment("gpu-2")]
            .filter(
              (environmentId) =>
                !(businessOsInstanceId === MANAGED && environmentId === backend) &&
                owners.get(environmentId)?.businessOsInstanceId !== businessOsInstanceId,
            )
            .map((environmentId) => ({
              environmentId,
              currentBusinessOsInstanceId: owners.get(environmentId)?.businessOsInstanceId ?? null,
              requiresCoLocationRiskConfirmation: environmentId === backend,
            })),
        );
      },
      unassign: (input) => {
        const current = owners.get(input.environmentId);
        const unassigned = current?.businessOsInstanceId === input.businessOsInstanceId;
        if (unassigned) owners.delete(input.environmentId);
        return Effect.succeed({ ...input, unassigned });
      },
    }),
  );
  return HttpApiTest.groups(WorkjetBusinessOsComputerMembershipHttpApi, [
    "businessOsComputers",
  ]).pipe(
    Effect.provide([
      NodeHttpServer.layerHttpServices,
      businessOsComputerMembershipHttpApiLayer.pipe(Layer.provide(storeLayer)),
    ]),
    Effect.provideService(EnvironmentAuthenticatedAuth, auth),
    Effect.scoped,
  );
}

describe("Business OS computer membership HTTP", () => {
  it.effect("lists and mutates only the explicitly scoped instance", () =>
    Effect.gen(function* () {
      const client = yield* clientFor(authenticatedAuth(new Set(["access:read", "access:write"])));
      yield* client.businessOsComputers.assign({
        headers: {},
        payload: { businessOsInstanceId: A, environmentId: environment("gpu-1") },
      });
      const moved = yield* client.businessOsComputers.assign({
        headers: {},
        payload: { businessOsInstanceId: B, environmentId: environment("gpu-1") },
      });
      expect(moved.previousBusinessOsInstanceId).toBe(A);
      expect(
        yield* client.businessOsComputers.unassign({
          headers: {},
          payload: { businessOsInstanceId: A, environmentId: environment("gpu-1") },
        }),
      ).toMatchObject({ unassigned: false });
      expect(
        yield* client.businessOsComputers.list({
          headers: {},
          payload: { businessOsInstanceId: A },
        }),
      ).toMatchObject({ businessOsInstanceId: A, assigned: [] });
      expect(
        yield* client.businessOsComputers.list({
          headers: {},
          payload: { businessOsInstanceId: B },
        }),
      ).toMatchObject({
        businessOsInstanceId: B,
        assigned: [{ environmentId: environment("gpu-1") }],
      });
    }),
  );

  it.effect("never offers or assigns a managed backend host", () =>
    Effect.gen(function* () {
      const client = yield* clientFor(authenticatedAuth(new Set(["access:read", "access:write"])));
      const listed = yield* client.businessOsComputers.list({
        headers: {},
        payload: { businessOsInstanceId: MANAGED },
      });
      expect(listed.available.map((candidate) => candidate.environmentId)).not.toContain(
        environment("managed-backend"),
      );
      expect(
        yield* Effect.flip(
          client.businessOsComputers.assign({
            headers: {},
            payload: {
              businessOsInstanceId: MANAGED,
              environmentId: environment("managed-backend"),
              coLocationRiskConfirmation: { policyVersion: 1, confirmed: true },
            },
          }),
        ),
      ).toMatchObject({
        _tag: "WorkjetBusinessOsComputerMembershipPolicyError",
        reason: "managed-backend-host",
      });
    }),
  );

  it.effect("requires explicit high-risk confirmation for self-hosted co-location", () =>
    Effect.gen(function* () {
      const client = yield* clientFor(authenticatedAuth(new Set(["access:write"])));
      const backend = environment(`${A}-backend`);
      expect(
        yield* Effect.flip(
          client.businessOsComputers.assign({
            headers: {},
            payload: { businessOsInstanceId: A, environmentId: backend },
          }),
        ),
      ).toMatchObject({
        _tag: "WorkjetBusinessOsComputerMembershipPolicyError",
        reason: "colocation-confirmation-required",
      });
      expect(
        yield* client.businessOsComputers.assign({
          headers: {},
          payload: {
            businessOsInstanceId: A,
            environmentId: backend,
            coLocationRiskConfirmation: { policyVersion: 1, confirmed: true },
          },
        }),
      ).toMatchObject({
        assignment: {
          environmentId: backend,
          coLocationRiskAcceptance: { policyVersion: 1 },
        },
      });
    }),
  );

  it.effect("enforces authentication and read/write scopes", () =>
    Effect.gen(function* () {
      const unauthenticated = yield* clientFor(unauthenticatedAuth);
      expect(
        yield* Effect.flip(
          unauthenticated.businessOsComputers.list({
            headers: {},
            payload: { businessOsInstanceId: A },
          }),
        ),
      ).toMatchObject({ _tag: "EnvironmentAuthInvalidError" });

      const readOnly = yield* clientFor(authenticatedAuth(new Set(["access:read"])));
      expect(
        yield* Effect.flip(
          readOnly.businessOsComputers.assign({
            headers: {},
            payload: { businessOsInstanceId: A, environmentId: environment("gpu-1") },
          }),
        ),
      ).toMatchObject({ _tag: "EnvironmentScopeRequiredError" });

      const writeOnly = yield* clientFor(authenticatedAuth(new Set(["access:write"])));
      expect(
        yield* Effect.flip(
          writeOnly.businessOsComputers.list({
            headers: {},
            payload: { businessOsInstanceId: A },
          }),
        ),
      ).toMatchObject({ _tag: "EnvironmentScopeRequiredError" });
    }),
  );

  it.effect("rejects missing identifiers and disables caches and referrers", () =>
    Effect.gen(function* () {
      const client = yield* clientFor(authenticatedAuth(new Set(["access:read", "access:write"])));
      expect(
        yield* Effect.flip(client.businessOsComputers.list({ headers: {}, payload: {} } as never)),
      ).toBeDefined();
      expect(
        yield* Effect.flip(
          client.businessOsComputers.unassign({
            headers: {},
            payload: { businessOsInstanceId: A },
          } as never),
        ),
      ).toBeDefined();
      expect(WORKJET_BUSINESS_OS_COMPUTER_RESPONSE_HEADERS).toEqual({
        "cache-control": "no-store",
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
      });
    }),
  );
});
