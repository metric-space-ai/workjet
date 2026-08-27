import {
  WorkjetBusinessOsComputerMembershipHttpApi,
  type WorkjetBusinessOsComputerAssignInput,
  type WorkjetBusinessOsComputerAssignResult,
  type WorkjetBusinessOsComputerListInput,
  type WorkjetBusinessOsComputerListResult,
  type WorkjetBusinessOsComputerUnassignInput,
  type WorkjetBusinessOsComputerUnassignResult,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest } from "../rpc/http.ts";
import {
  buildEnvironmentAuthHeaders,
  type EnvironmentHttpAuthHeaders,
  withEnvironmentCredentials,
} from "./environmentHttpAuth.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";

/**
 * Client half of the membership control-plane scaffold.
 *
 * The paths are intentionally not part of the live EnvironmentHttpApi yet. A
 * caller must not use these helpers until the server has an authoritative
 * adapter for canonical instance IDs, computer inventory and host identity.
 */
const REQUEST_TIMEOUT_MS = 10_000;
export const WORKJET_BUSINESS_OS_COMPUTERS_LIST_PATH = "/api/workjet/business-os/computers/list";
export const WORKJET_BUSINESS_OS_COMPUTERS_ASSIGN_PATH =
  "/api/workjet/business-os/computers/assign";
export const WORKJET_BUSINESS_OS_COMPUTERS_UNASSIGN_PATH =
  "/api/workjet/business-os/computers/unassign";

export class EnvironmentNotConnectedForBusinessOsComputerMembershipError extends Data.TaggedError(
  "EnvironmentNotConnectedForBusinessOsComputerMembershipError",
)<{ readonly message: string }> {
  constructor() {
    super({ message: "The selected Business OS instance is not connected." });
  }
}

const makeMembershipHttpClient = (httpBaseUrl: string) => {
  const url = new URL(httpBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return HttpApiClient.make(WorkjetBusinessOsComputerMembershipHttpApi, {
    baseUrl: url.toString(),
  });
};

const withCurrentEnvironmentConnection = Effect.fn(
  "clientRuntime.businessOsComputerMembership.withCurrentEnvironmentConnection",
)(function* <A, E>(
  path: string,
  request: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeMembershipHttpClient>>;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, HttpClient.HttpClient>,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new EnvironmentNotConnectedForBusinessOsComputerMembershipError();
  }
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const requestUrl = environmentEndpointUrl(prepared.value.httpBaseUrl, path);
  const client = yield* makeMembershipHttpClient(prepared.value.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    prepared.value.httpAuthorization,
    "POST",
    requestUrl,
    signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(prepared.value.httpAuthorization, request({ client, headers })),
  );
});

export const listWorkjetBusinessOsComputers = (
  input: WorkjetBusinessOsComputerListInput,
): Effect.Effect<
  WorkjetBusinessOsComputerListResult,
  unknown,
  EnvironmentSupervisor | HttpClient.HttpClient | ManagedRelayDpopSigner
> =>
  withCurrentEnvironmentConnection(WORKJET_BUSINESS_OS_COMPUTERS_LIST_PATH, ({ client, headers }) =>
    client.businessOsComputers.list({ headers, payload: input }),
  );

export const assignWorkjetBusinessOsComputer = (
  input: WorkjetBusinessOsComputerAssignInput,
): Effect.Effect<
  WorkjetBusinessOsComputerAssignResult,
  unknown,
  EnvironmentSupervisor | HttpClient.HttpClient | ManagedRelayDpopSigner
> =>
  withCurrentEnvironmentConnection(
    WORKJET_BUSINESS_OS_COMPUTERS_ASSIGN_PATH,
    ({ client, headers }) => client.businessOsComputers.assign({ headers, payload: input }),
  );

export const unassignWorkjetBusinessOsComputer = (
  input: WorkjetBusinessOsComputerUnassignInput,
): Effect.Effect<
  WorkjetBusinessOsComputerUnassignResult,
  unknown,
  EnvironmentSupervisor | HttpClient.HttpClient | ManagedRelayDpopSigner
> =>
  withCurrentEnvironmentConnection(
    WORKJET_BUSINESS_OS_COMPUTERS_UNASSIGN_PATH,
    ({ client, headers }) => client.businessOsComputers.unassign({ headers, payload: input }),
  );

export function businessOsComputerMembershipScopeKey(input: {
  readonly businessOsInstanceId: string;
  readonly environmentId?: string;
}): string {
  return `${input.businessOsInstanceId}\u0000${input.environmentId ?? ""}`;
}

export function createBusinessOsComputerMembershipAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | HttpClient.HttpClient | ManagedRelayDpopSigner | R,
    E
  >,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    list: createEnvironmentCommand(runtime, {
      label: "environment-control:business-os-computers:list",
      execute: listWorkjetBusinessOsComputers,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ input }) => businessOsComputerMembershipScopeKey(input),
      },
    }),
    assign: createEnvironmentCommand(runtime, {
      label: "environment-control:business-os-computers:assign",
      execute: assignWorkjetBusinessOsComputer,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ input }) => businessOsComputerMembershipScopeKey(input),
      },
    }),
    unassign: createEnvironmentCommand(runtime, {
      label: "environment-control:business-os-computers:unassign",
      execute: unassignWorkjetBusinessOsComputer,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ input }) => businessOsComputerMembershipScopeKey(input),
      },
    }),
  };
}
