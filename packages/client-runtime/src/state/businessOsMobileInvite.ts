import type {
  CtoxMobileInviteCreateInput,
  CtoxMobileInviteCreateResult,
  CtoxMobileInviteRevokeInput,
  CtoxMobileInviteRevokeResult,
  CtoxMobileShellPackResolveInput,
  CtoxMobileShellPackResolveResult,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import {
  buildEnvironmentAuthHeaders,
  type EnvironmentHttpAuthHeaders,
  withEnvironmentCredentials,
} from "./environmentHttpAuth.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";

const MOBILE_INVITE_REQUEST_TIMEOUT_MS = 10_000;
const MOBILE_SHELL_PACK_REQUEST_TIMEOUT_MS = 10_000;

export class EnvironmentNotConnectedForMobileInviteError extends Data.TaggedError(
  "EnvironmentNotConnectedForMobileInviteError",
)<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "The selected CTOX backend is not connected." });
  }
}

export class EnvironmentNotConnectedForMobileShellPackError extends Data.TaggedError(
  "EnvironmentNotConnectedForMobileShellPackError",
)<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "The selected CTOX backend is not connected." });
  }
}

const withCurrentEnvironmentConnection = Effect.fn(
  "clientRuntime.businessOsMobileControl.withCurrentEnvironmentConnection",
)(function* <A, E>(
  path: string,
  timeoutMs: number,
  notConnectedError:
    | EnvironmentNotConnectedForMobileInviteError
    | EnvironmentNotConnectedForMobileShellPackError,
  request: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, HttpClient.HttpClient>,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* notConnectedError;
  }
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const requestUrl = environmentEndpointUrl(prepared.value.httpBaseUrl, path);
  const client = yield* makeEnvironmentHttpApiClient(prepared.value.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    prepared.value.httpAuthorization,
    "POST",
    requestUrl,
    signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    timeoutMs,
    withEnvironmentCredentials(prepared.value.httpAuthorization, request({ client, headers })),
  );
});

export const createBusinessOsMobileInvite = (
  input: CtoxMobileInviteCreateInput,
): Effect.Effect<
  CtoxMobileInviteCreateResult,
  unknown,
  EnvironmentSupervisor | HttpClient.HttpClient | ManagedRelayDpopSigner
> =>
  withCurrentEnvironmentConnection(
    "/api/ctox/business-os/mobile-invites",
    MOBILE_INVITE_REQUEST_TIMEOUT_MS,
    new EnvironmentNotConnectedForMobileInviteError(),
    ({ client, headers }) => client.businessOs.createMobileInvite({ headers, payload: input }),
  );

export const revokeBusinessOsMobileInvite = (
  input: CtoxMobileInviteRevokeInput,
): Effect.Effect<
  CtoxMobileInviteRevokeResult,
  unknown,
  EnvironmentSupervisor | HttpClient.HttpClient | ManagedRelayDpopSigner
> =>
  withCurrentEnvironmentConnection(
    "/api/ctox/business-os/mobile-invites/revoke",
    MOBILE_INVITE_REQUEST_TIMEOUT_MS,
    new EnvironmentNotConnectedForMobileInviteError(),
    ({ client, headers }) => client.businessOs.revokeMobileInvite({ headers, payload: input }),
  );

export const resolveBusinessOsMobileShellPack = (
  input: CtoxMobileShellPackResolveInput,
): Effect.Effect<
  CtoxMobileShellPackResolveResult,
  unknown,
  EnvironmentSupervisor | HttpClient.HttpClient | ManagedRelayDpopSigner
> =>
  withCurrentEnvironmentConnection(
    "/api/ctox/business-os/mobile-shell-packs/resolve",
    MOBILE_SHELL_PACK_REQUEST_TIMEOUT_MS,
    new EnvironmentNotConnectedForMobileShellPackError(),
    ({ client, headers }) => client.businessOs.resolveMobileShellPack({ headers, payload: input }),
  );

export function createBusinessOsMobileInviteEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | HttpClient.HttpClient | ManagedRelayDpopSigner | R,
    E
  >,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-control:business-os-mobile-invite:create",
      execute: createBusinessOsMobileInvite,
      scheduler,
      concurrency,
    }),
    revoke: createEnvironmentCommand(runtime, {
      label: "environment-control:business-os-mobile-invite:revoke",
      execute: revokeBusinessOsMobileInvite,
      scheduler,
      concurrency,
    }),
  };
}

export function createBusinessOsMobileShellPackEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | HttpClient.HttpClient | ManagedRelayDpopSigner | R,
    E
  >,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    resolve: createEnvironmentCommand(runtime, {
      label: "environment-control:business-os-mobile-shell-pack:resolve",
      execute: resolveBusinessOsMobileShellPack,
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
      },
    }),
  };
}
