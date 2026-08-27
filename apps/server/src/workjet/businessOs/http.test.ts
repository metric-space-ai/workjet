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
import { describe, expect, it } from "vite-plus/test";

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

async function clientFor(auth: typeof EnvironmentAuthenticatedAuth.Service) {
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
  return Effect.runPromise(
    HttpApiTest.groups(WorkjetBusinessOsComputerMembershipHttpApi, ["businessOsComputers"]).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        businessOsComputerMembershipHttpApiLayer.pipe(Layer.provide(storeLayer)),
      ]),
      Effect.provideService(EnvironmentAuthenticatedAuth, auth),
      Effect.scoped,
    ),
  );
}

describe("Business OS computer membership HTTP", () => {
  it("lists and mutates only the explicitly scoped instance", async () => {
    const client = await clientFor(authenticatedAuth(new Set(["access:read", "access:write"])));
    await Effect.runPromise(
      client.businessOsComputers.assign({
        headers: {},
        payload: { businessOsInstanceId: A, environmentId: environment("gpu-1") },
      }),
    );
    const moved = await Effect.runPromise(
      client.businessOsComputers.assign({
        headers: {},
        payload: { businessOsInstanceId: B, environmentId: environment("gpu-1") },
      }),
    );
    expect(moved.previousBusinessOsInstanceId).toBe(A);
    await expect(
      Effect.runPromise(
        client.businessOsComputers.unassign({
          headers: {},
          payload: { businessOsInstanceId: A, environmentId: environment("gpu-1") },
        }),
      ),
    ).resolves.toMatchObject({ unassigned: false });
    await expect(
      Effect.runPromise(
        client.businessOsComputers.list({
          headers: {},
          payload: { businessOsInstanceId: A },
        }),
      ),
    ).resolves.toMatchObject({ businessOsInstanceId: A, assigned: [] });
    await expect(
      Effect.runPromise(
        client.businessOsComputers.list({
          headers: {},
          payload: { businessOsInstanceId: B },
        }),
      ),
    ).resolves.toMatchObject({
      businessOsInstanceId: B,
      assigned: [{ environmentId: environment("gpu-1") }],
    });
  });

  it("never offers or assigns a managed backend host", async () => {
    const client = await clientFor(authenticatedAuth(new Set(["access:read", "access:write"])));
    const listed = await Effect.runPromise(
      client.businessOsComputers.list({
        headers: {},
        payload: { businessOsInstanceId: MANAGED },
      }),
    );
    expect(listed.available.map((candidate) => candidate.environmentId)).not.toContain(
      environment("managed-backend"),
    );
    await expect(
      Effect.runPromise(
        client.businessOsComputers.assign({
          headers: {},
          payload: {
            businessOsInstanceId: MANAGED,
            environmentId: environment("managed-backend"),
            coLocationRiskConfirmation: { policyVersion: 1, confirmed: true },
          },
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "WorkjetBusinessOsComputerMembershipPolicyError",
      reason: "managed-backend-host",
    });
  });

  it("requires explicit high-risk confirmation for self-hosted co-location", async () => {
    const client = await clientFor(authenticatedAuth(new Set(["access:write"])));
    const backend = environment(`${A}-backend`);
    await expect(
      Effect.runPromise(
        client.businessOsComputers.assign({
          headers: {},
          payload: { businessOsInstanceId: A, environmentId: backend },
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "WorkjetBusinessOsComputerMembershipPolicyError",
      reason: "colocation-confirmation-required",
    });
    await expect(
      Effect.runPromise(
        client.businessOsComputers.assign({
          headers: {},
          payload: {
            businessOsInstanceId: A,
            environmentId: backend,
            coLocationRiskConfirmation: { policyVersion: 1, confirmed: true },
          },
        }),
      ),
    ).resolves.toMatchObject({
      assignment: {
        environmentId: backend,
        coLocationRiskAcceptance: { policyVersion: 1 },
      },
    });
  });

  it("enforces authentication and read/write scopes", async () => {
    const unauthenticated = await clientFor(unauthenticatedAuth);
    await expect(
      Effect.runPromise(
        unauthenticated.businessOsComputers.list({
          headers: {},
          payload: { businessOsInstanceId: A },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "EnvironmentAuthInvalidError" });

    const readOnly = await clientFor(authenticatedAuth(new Set(["access:read"])));
    await expect(
      Effect.runPromise(
        readOnly.businessOsComputers.assign({
          headers: {},
          payload: { businessOsInstanceId: A, environmentId: environment("gpu-1") },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "EnvironmentScopeRequiredError" });

    const writeOnly = await clientFor(authenticatedAuth(new Set(["access:write"])));
    await expect(
      Effect.runPromise(
        writeOnly.businessOsComputers.list({
          headers: {},
          payload: { businessOsInstanceId: A },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "EnvironmentScopeRequiredError" });
  });

  it("rejects missing identifiers and disables caches and referrers", async () => {
    const client = await clientFor(authenticatedAuth(new Set(["access:read", "access:write"])));
    await expect(
      Effect.runPromise(client.businessOsComputers.list({ headers: {}, payload: {} } as never)),
    ).rejects.toBeDefined();
    await expect(
      Effect.runPromise(
        client.businessOsComputers.unassign({
          headers: {},
          payload: { businessOsInstanceId: A },
        } as never),
      ),
    ).rejects.toBeDefined();
    expect(WORKJET_BUSINESS_OS_COMPUTER_RESPONSE_HEADERS).toEqual({
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
    });
  });
});
