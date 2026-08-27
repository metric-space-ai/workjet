import {
  WORKJET_MANAGED_DEVICE_BINDINGS_LIST_PATH,
  WORKJET_MANAGED_DEVICE_BINDINGS_REVOKE_PATH,
  WORKJET_MANAGED_DEVICE_CONTROL_CSRF_PATH,
  WORKJET_MANAGED_DEVICE_CONTROL_RESOLVE_PATH,
  WORKJET_MANAGED_DEVICE_INVITES_CREATE_PATH,
  WORKJET_MANAGED_DEVICE_INVITES_MANUAL_CONNECTION_PATH,
  WORKJET_MANAGED_DEVICE_INVITES_REVOKE_PATH,
  WorkjetDeviceBindingListResult,
  WorkjetDeviceInviteCreateResult,
  WorkjetDeviceInviteRevokeResult,
  WorkjetManagedDeviceInviteManualConnectionResult,
  WorkjetManagedBackendControlResolveResult,
  WorkjetManagedControlCsrfResult,
  type BusinessOsInstanceId,
  type WorkjetManagedBackendControlConnectionId,
} from "@t3tools/contracts";
import {
  WorkjetManagedBackendControlClient,
  WorkjetManagedBackendControlClientError,
} from "@t3tools/client-runtime/state/business-os-managed-backend-control";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { resolveCloudPublicConfig } from "./publicConfig";

const REQUEST_TIMEOUT_MS = 15_000;
const CSRF_EXPIRY_SKEW_MS = 10_000;

type Operation = WorkjetManagedBackendControlClientError["operation"];
type ControlScope = {
  readonly backendControlConnectionId: WorkjetManagedBackendControlConnectionId;
  readonly businessOsInstanceId: BusinessOsInstanceId;
};

const responseSchemas = {
  resolve: WorkjetManagedBackendControlResolveResult,
  csrf: WorkjetManagedControlCsrfResult,
  list: WorkjetDeviceBindingListResult,
  create: WorkjetDeviceInviteCreateResult,
  manual: WorkjetManagedDeviceInviteManualConnectionResult,
  revoke: WorkjetDeviceInviteRevokeResult,
};

function clientError(operation: Operation, message: string) {
  return new WorkjetManagedBackendControlClientError({ operation, message });
}

function managedControlUrl(path: string, operation: Operation): string {
  const origin = resolveCloudPublicConfig().managedControlUrl;
  if (origin === null) throw clientError(operation, "Managed device control is not configured.");
  return new URL(path, `${origin}/`).toString();
}

function responseError(operation: Operation, status: number) {
  if (status === 401) return clientError(operation, "Managed device authentication failed.");
  if (status === 403) return clientError(operation, "Managed device control was denied.");
  if (status === 410) return clientError(operation, "Managed device control expired.");
  if (status === 429) return clientError(operation, "Managed device control is rate limited.");
  return clientError(operation, "Managed device control is unavailable.");
}

/** Browser/Desktop adapter for the cookie-free, instance-bound managed control plane. */
export const managedBackendControlClientLayer = Layer.effect(
  WorkjetManagedBackendControlClient,
  Effect.gen(function* () {
    const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
    const httpClient = yield* HttpClient.HttpClient;
    const csrfTokens = new Map<
      WorkjetManagedBackendControlConnectionId,
      { readonly token: string; readonly expiresAtMs: number }
    >();

    const request = <A>(input: {
      readonly operation: Operation;
      readonly path: string;
      readonly payload: unknown;
      readonly schema: Schema.ConstraintDecoder<A, never>;
      readonly csrfToken?: string;
    }): Effect.Effect<A, WorkjetManagedBackendControlClientError> =>
      Effect.gen(function* () {
        const url = managedControlUrl(input.path, input.operation);
        const proof = yield* signer
          .createProof({ method: "POST", url })
          .pipe(
            Effect.mapError(() => clientError(input.operation, "Managed device proof failed.")),
          );
        const response = yield* HttpClientRequest.post(url).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeaders({
            dpop: proof,
            ...(input.csrfToken ? { "x-workjet-csrf": input.csrfToken } : {}),
          }),
          HttpClientRequest.bodyJson(input.payload),
          Effect.flatMap(httpClient.execute),
          Effect.timeout(`${REQUEST_TIMEOUT_MS} millis`),
          Effect.mapError(() =>
            clientError(input.operation, "Managed device control is unavailable."),
          ),
        );
        if (response.status < 200 || response.status >= 300) {
          return yield* responseError(input.operation, response.status);
        }
        return yield* HttpClientResponse.schemaBodyJson(input.schema)(response).pipe(
          Effect.mapError(() =>
            clientError(input.operation, "Managed device control returned an invalid response."),
          ),
        );
      });

    const issueCsrf = (scope: ControlScope, operation: Operation) =>
      request({
        operation,
        path: WORKJET_MANAGED_DEVICE_CONTROL_CSRF_PATH,
        payload: scope,
        schema: responseSchemas.csrf,
      }).pipe(
        Effect.filterOrFail(
          (result) => {
            const expiresAtMs = Date.parse(result.expiresAt);
            if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;
            csrfTokens.set(scope.backendControlConnectionId, {
              token: result.csrfToken,
              expiresAtMs,
            });
            return true;
          },
          () => clientError(operation, "Managed device control returned an expired CSRF token."),
        ),
        Effect.map((result) => result.csrfToken),
      );

    const csrf = (scope: ControlScope, operation: Operation) => {
      const cached = csrfTokens.get(scope.backendControlConnectionId);
      return cached && cached.expiresAtMs > Date.now() + CSRF_EXPIRY_SKEW_MS
        ? Effect.succeed(cached.token)
        : issueCsrf(scope, operation);
    };

    const protectedRequest = <A>(input: {
      readonly operation: Operation;
      readonly path: string;
      readonly payload: ControlScope;
      readonly schema: Schema.ConstraintDecoder<A, never>;
    }) =>
      csrf(input.payload, input.operation).pipe(
        Effect.flatMap((csrfToken) => request({ ...input, csrfToken })),
      );

    return WorkjetManagedBackendControlClient.of({
      resolve: (input) =>
        request({
          operation: "resolve",
          path: WORKJET_MANAGED_DEVICE_CONTROL_RESOLVE_PATH,
          payload: input,
          schema: responseSchemas.resolve,
        }).pipe(
          Effect.filterOrFail(
            (result) => result.businessOsInstanceId === input.businessOsInstanceId,
            () => clientError("resolve", "Managed device control returned a different instance."),
          ),
          Effect.tap((result) => issueCsrf(result, "resolve")),
        ),
      listDeviceBindings: (input) =>
        protectedRequest({
          operation: "list",
          path: WORKJET_MANAGED_DEVICE_BINDINGS_LIST_PATH,
          payload: input,
          schema: responseSchemas.list,
        }),
      createDeviceInvite: (input) =>
        protectedRequest({
          operation: "create",
          path: WORKJET_MANAGED_DEVICE_INVITES_CREATE_PATH,
          payload: input,
          schema: responseSchemas.create,
        }),
      revokeDeviceInvite: (input) =>
        protectedRequest({
          operation: "revoke",
          path: WORKJET_MANAGED_DEVICE_INVITES_REVOKE_PATH,
          payload: input,
          schema: responseSchemas.revoke,
        }),
      readDeviceInviteManualConnection: (input) =>
        protectedRequest({
          operation: "manual",
          path: WORKJET_MANAGED_DEVICE_INVITES_MANUAL_CONNECTION_PATH,
          payload: input,
          schema: responseSchemas.manual,
        }),
      revokeDeviceBinding: (input) =>
        protectedRequest({
          operation: "revoke",
          path: WORKJET_MANAGED_DEVICE_BINDINGS_REVOKE_PATH,
          payload: input,
          schema: responseSchemas.revoke,
        }),
    });
  }),
);
