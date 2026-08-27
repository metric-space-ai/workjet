import {
  WORKJET_RELAY_CONTROL_IDENTITY_ASSERTION_PATH,
  WorkjetDeviceInviteV2,
  WorkjetDeviceSessionBootstrapExchangeResult,
  WorkjetDeviceSessionMembershipReadResult,
  WorkjetDeviceSessionRenewResult,
  WorkjetRelayControlIdentityAssertionIssueResult,
} from "@t3tools/contracts";
import { RelayEnvironmentConnectResponse } from "@t3tools/contracts/relay";
import {
  WorkjetManagedDeviceSessionClient,
  WorkjetManagedDeviceSessionClientError,
  WorkjetManagedDeviceSessionAuthorizationProvider,
  renewManagedWorkjetDeviceSession,
  type WorkjetManagedDeviceSessionAuthorization,
  type WorkjetManagedDeviceSessionOperation,
} from "@t3tools/client-runtime/state/business-os-managed-backend-control";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { createDpopProofWithSigner, type DpopProofSigner } from "../cloud/dpop";
import { loadNativeWorkjetDpopSigner } from "../cloud/nativeWorkjetDpopSigner";
import { nativeWorkjetDeviceSessionStore } from "../business-os/registry/native-business-os-registry";
import { loadWorkjetDeviceSession, saveWorkjetDeviceSession } from "./workjet-device-session-store";

const REQUEST_TIMEOUT_MS = 15_000;
const decodeDeviceInvite = Schema.decodeUnknownEffect(WorkjetDeviceInviteV2);
const decodeSessionBootstrap = Schema.decodeUnknownEffect(
  WorkjetDeviceSessionBootstrapExchangeResult,
);
const decodeSessionMembership = Schema.decodeUnknownEffect(
  WorkjetDeviceSessionMembershipReadResult,
);
const decodeSessionRenewal = Schema.decodeUnknownEffect(WorkjetDeviceSessionRenewResult);
const decodeRelayEnvironmentConnect = Schema.decodeUnknownEffect(RelayEnvironmentConnectResponse);

function failure(operation: WorkjetManagedDeviceSessionOperation) {
  return new WorkjetManagedDeviceSessionClientError({ operation, code: "request_failed" });
}

function postJson<A, E, R>(input: {
  readonly operation: WorkjetManagedDeviceSessionOperation;
  readonly url: string;
  readonly payload: unknown;
  readonly accessToken?: string;
  readonly decode: (payload: unknown) => Effect.Effect<A, E, R>;
  readonly signer: DpopProofSigner;
  readonly crypto: Crypto.Crypto;
}): Effect.Effect<A, WorkjetManagedDeviceSessionClientError, R> {
  return Effect.gen(function* () {
    const proof = yield* createDpopProofWithSigner({
      method: "POST",
      url: input.url,
      ...(input.accessToken ? { accessToken: input.accessToken } : {}),
      signer: input.signer,
    }).pipe(
      Effect.provideService(Crypto.Crypto, input.crypto),
      Effect.mapError(() => failure(input.operation)),
    );
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(input.url, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            dpop: proof.proof,
            ...(input.accessToken ? { authorization: `DPoP ${input.accessToken}` } : {}),
          },
          body: JSON.stringify(input.payload),
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
        }),
      catch: () => failure(input.operation),
    }).pipe(
      Effect.timeout(REQUEST_TIMEOUT_MS),
      Effect.mapError(() => failure(input.operation)),
    );
    if (!response.ok) return yield* failure(input.operation);
    const payload = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => failure(input.operation),
    });
    return yield* input.decode(payload).pipe(Effect.mapError(() => failure(input.operation)));
  });
}

/**
 * Mobile implementation of the possession-bound reference/session transport.
 * It never logs request bodies or response bodies because both can carry an
 * invite, bootstrap credential, access token, or rotating refresh grant.
 */
export const workjetManagedDeviceSessionClientLayer = Layer.effect(
  WorkjetManagedDeviceSessionClient,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const request = <A, E, R>(input: {
      readonly operation: WorkjetManagedDeviceSessionOperation;
      readonly url: string;
      readonly payload: unknown;
      readonly accessToken?: string;
      readonly decode: (payload: unknown) => Effect.Effect<A, E, R>;
    }) =>
      loadNativeWorkjetDpopSigner().pipe(
        Effect.mapError(() => failure(input.operation)),
        Effect.flatMap((signer) => postJson({ ...input, signer, crypto })),
      );

    return WorkjetManagedDeviceSessionClient.of({
      issueControlIdentityAssertion: (input) =>
        Effect.gen(function* () {
          const authorization = yield* Effect.tryPromise({
            try: () =>
              loadWorkjetDeviceSession(
                input.payload.businessOsInstanceId,
                nativeWorkjetDeviceSessionStore,
              ),
            catch: () => failure("identity"),
          });
          if (
            authorization === null ||
            authorization.deviceId !== input.payload.workjetInstallationId ||
            new URL(
              WORKJET_RELAY_CONTROL_IDENTITY_ASSERTION_PATH,
              authorization.relayIssuer,
            ).toString() !== input.target.url
          ) {
            return yield* new WorkjetManagedDeviceSessionClientError({
              operation: "identity",
              code: "authentication_failed",
            });
          }
          return yield* request({
            operation: "identity",
            url: input.target.url,
            payload: input.payload,
            accessToken: authorization.accessToken,
            decode: Schema.decodeUnknownEffect(WorkjetRelayControlIdentityAssertionIssueResult),
          });
        }),
      connectEnvironment: (input) => {
        const url = new URL(
          `/v1/environments/${encodeURIComponent(input.environmentId)}/connect`,
          input.relayIssuer,
        ).toString();
        return loadNativeWorkjetDpopSigner().pipe(
          Effect.mapError(() => failure("connect")),
          Effect.flatMap((signer) =>
            postJson({
              operation: "connect",
              url,
              payload: {
                deviceId: input.deviceId,
                clientKeyThumbprint: signer.thumbprint,
              },
              accessToken: input.accessToken,
              decode: decodeRelayEnvironmentConnect,
              signer,
              crypto,
            }),
          ),
        );
      },
      redeemDeviceInvite: (input) =>
        request({
          operation: "redeem",
          url: input.target.url,
          payload: input.payload,
          decode: decodeDeviceInvite,
        }),
      exchangeDeviceSessionBootstrap: (input) =>
        request({
          operation: "exchange",
          url: input.target.url,
          payload: input.payload,
          decode: decodeSessionBootstrap,
        }),
      renewDeviceSession: (input) =>
        request({
          operation: "renew",
          url: input.target.url,
          payload: input.payload,
          decode: decodeSessionRenewal,
        }),
      readDeviceSessionMembership: (input) =>
        request({
          operation: "membership",
          url: input.target.url,
          payload: input.payload,
          accessToken: input.accessToken,
          decode: decodeSessionMembership,
        }),
    });
  }),
);

export const workjetManagedDeviceSessionAuthorizationProviderLayer = Layer.effect(
  WorkjetManagedDeviceSessionAuthorizationProvider,
  Effect.gen(function* () {
    const client = yield* WorkjetManagedDeviceSessionClient;
    const renewals = new Map<string, Promise<WorkjetManagedDeviceSessionAuthorization>>();

    const renewOnce = (authorization: WorkjetManagedDeviceSessionAuthorization) => {
      const key = authorization.businessOsInstanceId;
      const active = renewals.get(key);
      if (active) return active;
      const renewal = Effect.runPromise(
        renewManagedWorkjetDeviceSession({ authorization }).pipe(
          Effect.provideService(WorkjetManagedDeviceSessionClient, client),
        ),
      )
        .then(async (renewed) => {
          if (
            renewed.businessOsInstanceId !== authorization.businessOsInstanceId ||
            renewed.deviceId !== authorization.deviceId
          ) {
            throw failure("renew");
          }
          await saveWorkjetDeviceSession(renewed, nativeWorkjetDeviceSessionStore);
          return renewed;
        })
        .finally(() => renewals.delete(key));
      renewals.set(key, renewal);
      return renewal;
    };

    return WorkjetManagedDeviceSessionAuthorizationProvider.of({
      read: (input) =>
        Effect.tryPromise({
          try: () =>
            loadWorkjetDeviceSession(input.businessOsInstanceId, nativeWorkjetDeviceSessionStore),
          catch: () => failure("membership"),
        }).pipe(
          Effect.flatMap((authorization) => {
            if (authorization === null) return Effect.fail(failure("membership"));
            const now = Date.now();
            const expiresAt = Date.parse(authorization.expiresAt);
            const refreshExpiresAt = Date.parse(authorization.refreshExpiresAt);
            if (!Number.isFinite(expiresAt) || !Number.isFinite(refreshExpiresAt)) {
              return Effect.fail(failure("renew"));
            }
            if (expiresAt > now + 60_000) return Effect.succeed(authorization);
            if (refreshExpiresAt <= now) return Effect.fail(failure("renew"));
            return Effect.tryPromise({
              try: () => renewOnce(authorization),
              catch: () => failure("renew"),
            });
          }),
        ),
    });
  }),
).pipe(Layer.provide(workjetManagedDeviceSessionClientLayer));

export const workjetManagedDeviceSessionLayer = Layer.merge(
  workjetManagedDeviceSessionClientLayer,
  workjetManagedDeviceSessionAuthorizationProviderLayer,
);
