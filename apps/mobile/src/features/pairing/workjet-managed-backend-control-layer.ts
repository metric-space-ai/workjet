import {
  WORKJET_MANAGED_DEVICE_BINDINGS_LIST_PATH,
  WORKJET_MANAGED_DEVICE_BINDINGS_REVOKE_PATH,
  WORKJET_MANAGED_DEVICE_CONTROL_CSRF_PATH,
  WORKJET_MANAGED_DEVICE_CONTROL_RESOLVE_PATH,
  WORKJET_MANAGED_DEVICE_INVITES_CREATE_PATH,
  WORKJET_MANAGED_DEVICE_INVITES_REVOKE_PATH,
  WorkjetDeviceBindingListResult,
  WorkjetDeviceInviteCreateResult,
  WorkjetDeviceInviteRevokeResult,
  WorkjetManagedBackendControlResolveResult,
  WorkjetManagedControlCsrfResult,
  type BusinessOsInstanceId,
  type WorkjetManagedBackendControlConnectionId,
} from "@t3tools/contracts";
import {
  WorkjetManagedBackendControlClient,
  WorkjetManagedBackendControlClientError,
} from "@t3tools/client-runtime/state/business-os-managed-backend-control";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { createDpopProofWithSigner, type DpopProofSigner } from "../cloud/dpop";
import { loadNativeWorkjetDpopSigner } from "../cloud/nativeWorkjetDpopSigner";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";

const REQUEST_TIMEOUT_MS = 15_000;
const CSRF_EXPIRY_SKEW_MS = 10_000;

type Operation = WorkjetManagedBackendControlClientError["operation"];
type ControlScope = {
  readonly backendControlConnectionId: WorkjetManagedBackendControlConnectionId;
  readonly businessOsInstanceId: BusinessOsInstanceId;
};

const decodeBackendControlResolve = Schema.decodeUnknownSync(
  WorkjetManagedBackendControlResolveResult,
);
const decodeControlCsrf = Schema.decodeUnknownSync(WorkjetManagedControlCsrfResult);
const decodeDeviceBindingList = Schema.decodeUnknownSync(WorkjetDeviceBindingListResult);
const decodeDeviceInviteCreate = Schema.decodeUnknownSync(WorkjetDeviceInviteCreateResult);
const decodeDeviceInviteRevoke = Schema.decodeUnknownSync(WorkjetDeviceInviteRevokeResult);

function clientError(operation: Operation, message: string) {
  return new WorkjetManagedBackendControlClientError({ operation, message });
}

function managedControlUrl(path: string, operation: Operation): string {
  const origin = resolveCloudPublicConfig().managedControl.url;
  if (!origin) throw clientError(operation, "Managed device control is not configured.");
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.origin !== origin) {
    throw clientError(operation, "Managed device control is not configured.");
  }
  return new URL(path, `${origin}/`).toString();
}

function responseError(operation: Operation, status: number) {
  if (status === 401) return clientError(operation, "Managed device authentication failed.");
  if (status === 403) return clientError(operation, "Managed device control was denied.");
  if (status === 410) return clientError(operation, "Managed device control expired.");
  if (status === 429) return clientError(operation, "Managed device control is rate limited.");
  return clientError(operation, "Managed device control is unavailable.");
}

async function postJson(input: {
  readonly operation: Operation;
  readonly path: string;
  readonly payload: unknown;
  readonly signer: DpopProofSigner;
  readonly crypto: Crypto.Crypto;
  readonly csrfToken?: string;
}): Promise<unknown> {
  const url = managedControlUrl(input.path, input.operation);
  const proof = await Effect.runPromise(
    createDpopProofWithSigner({ method: "POST", url, signer: input.signer }).pipe(
      Effect.provideService(Crypto.Crypto, input.crypto),
    ),
  ).catch(() => {
    throw clientError(input.operation, "Managed device proof failed.");
  });
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      dpop: proof.proof,
      ...(input.csrfToken ? { "x-workjet-csrf": input.csrfToken } : {}),
    },
    body: JSON.stringify(input.payload),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: abortController.signal,
  })
    .catch(() => {
      throw clientError(input.operation, "Managed device control is unavailable.");
    })
    .finally(() => clearTimeout(timeout));
  if (!response.ok) throw responseError(input.operation, response.status);
  return response.json().catch(() => {
    throw clientError(input.operation, "Managed device control returned an invalid response.");
  });
}

/** Mobile cookie-free adapter for a previously paired installation. */
export const workjetManagedBackendControlClientLayer = Layer.effect(
  WorkjetManagedBackendControlClient,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    let signerPromise: Promise<DpopProofSigner> | null = null;
    const csrfTokens = new Map<
      WorkjetManagedBackendControlConnectionId,
      { readonly token: string; readonly expiresAtMs: number }
    >();

    const signer = () => {
      const active = signerPromise;
      if (active) return active;
      const next = Effect.runPromise(loadNativeWorkjetDpopSigner()).catch((cause) => {
        signerPromise = null;
        throw cause;
      });
      signerPromise = next;
      return next;
    };

    const request = async <A>(input: {
      readonly operation: Operation;
      readonly path: string;
      readonly payload: unknown;
      readonly decode: (payload: unknown) => A;
      readonly csrfToken?: string;
    }): Promise<A> => {
      const payload = await postJson({ ...input, signer: await signer(), crypto });
      try {
        return input.decode(payload);
      } catch {
        throw clientError(input.operation, "Managed device control returned an invalid response.");
      }
    };

    const issueCsrf = async (scope: ControlScope, operation: Operation) => {
      const result = await request({
        operation,
        path: WORKJET_MANAGED_DEVICE_CONTROL_CSRF_PATH,
        payload: scope,
        decode: decodeControlCsrf,
      });
      const expiresAtMs = Date.parse(result.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        throw clientError(operation, "Managed device control returned an expired CSRF token.");
      }
      csrfTokens.set(scope.backendControlConnectionId, {
        token: result.csrfToken,
        expiresAtMs,
      });
      return result.csrfToken;
    };

    const csrf = async (scope: ControlScope, operation: Operation) => {
      const cached = csrfTokens.get(scope.backendControlConnectionId);
      return cached && cached.expiresAtMs > Date.now() + CSRF_EXPIRY_SKEW_MS
        ? cached.token
        : issueCsrf(scope, operation);
    };

    const protectedRequest = async <A>(input: {
      readonly operation: Operation;
      readonly path: string;
      readonly payload: ControlScope;
      readonly decode: (payload: unknown) => A;
    }): Promise<A> =>
      request({
        ...input,
        csrfToken: await csrf(input.payload, input.operation),
      });

    const effect = <A>(operation: Operation, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          cause instanceof WorkjetManagedBackendControlClientError
            ? cause
            : clientError(operation, "Managed device control is unavailable."),
      });

    return WorkjetManagedBackendControlClient.of({
      resolve: (input) =>
        effect("resolve", async () => {
          const result = await request({
            operation: "resolve",
            path: WORKJET_MANAGED_DEVICE_CONTROL_RESOLVE_PATH,
            payload: input,
            decode: decodeBackendControlResolve,
          });
          if (result.businessOsInstanceId !== input.businessOsInstanceId) {
            throw clientError("resolve", "Managed device control returned a different instance.");
          }
          await issueCsrf(result, "resolve");
          return result;
        }),
      listDeviceBindings: (input) =>
        effect("list", () =>
          protectedRequest({
            operation: "list",
            path: WORKJET_MANAGED_DEVICE_BINDINGS_LIST_PATH,
            payload: input,
            decode: decodeDeviceBindingList,
          }),
        ),
      createDeviceInvite: (input) =>
        effect("create", () =>
          protectedRequest({
            operation: "create",
            path: WORKJET_MANAGED_DEVICE_INVITES_CREATE_PATH,
            payload: input,
            decode: decodeDeviceInviteCreate,
          }),
        ),
      revokeDeviceInvite: (input) =>
        effect("revoke", () =>
          protectedRequest({
            operation: "revoke",
            path: WORKJET_MANAGED_DEVICE_INVITES_REVOKE_PATH,
            payload: input,
            decode: decodeDeviceInviteRevoke,
          }),
        ),
      revokeDeviceBinding: (input) =>
        effect("revoke", () =>
          protectedRequest({
            operation: "revoke",
            path: WORKJET_MANAGED_DEVICE_BINDINGS_REVOKE_PATH,
            payload: input,
            decode: decodeDeviceInviteRevoke,
          }),
        ),
    });
  }),
);
