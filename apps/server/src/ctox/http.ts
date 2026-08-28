// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  EnvironmentInternalError,
  EnvironmentHttpApi,
  WorkjetDeviceInviteRedeemRateLimitedError,
  WorkjetDeviceInviteRedeemRejectedError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { CtoxMobileInviteService } from "./CtoxMobileInviteService.ts";
import { CtoxMobileShellPackService } from "./CtoxMobileShellPackService.ts";
import {
  WorkjetDeviceInviteReferenceService,
  type WorkjetDeviceInviteReferenceServiceError,
} from "./WorkjetDeviceInviteReferenceService.ts";

export const MOBILE_INVITE_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
} as const;

const appendMobileInviteResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, MOBILE_INVITE_RESPONSE_HEADERS)),
);

export function normalizeDeviceConnectionUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1";
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/$/u, "");
    url.search = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

type DeviceInviteRedeemHttpError =
  | EnvironmentInternalError
  | WorkjetDeviceInviteRedeemRateLimitedError
  | WorkjetDeviceInviteRedeemRejectedError;

function mapDeviceInviteReferenceError(
  error: WorkjetDeviceInviteReferenceServiceError,
): Effect.Effect<never, DeviceInviteRedeemHttpError> {
  if (error.reason === "rate_limited") {
    return Effect.fail(
      new WorkjetDeviceInviteRedeemRateLimitedError({ code: "device_invite_rate_limited" }),
    );
  }
  if (error.reason === "rejected") {
    return Effect.fail(
      new WorkjetDeviceInviteRedeemRejectedError({ code: "device_invite_unavailable" }),
    );
  }
  return failEnvironmentInternal("device_invite_redemption_failed");
}

function deviceInviteRateLimitKey(source: unknown): string {
  if (source && typeof source === "object") {
    const candidate = source as {
      readonly remoteAddress?: string | null;
      readonly socket?: { readonly remoteAddress?: string | null };
    };
    const remoteAddress = candidate.socket?.remoteAddress ?? candidate.remoteAddress;
    if (typeof remoteAddress === "string" && remoteAddress.trim().length > 0) {
      return remoteAddress.trim();
    }
  }
  return "unknown-client";
}

export const businessOsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "businessOs",
  Effect.fnUntraced(function* (handlers) {
    const mobileInvites = yield* CtoxMobileInviteService;
    const mobileShellPacks = yield* CtoxMobileShellPackService;
    const deviceInviteReferences = yield* WorkjetDeviceInviteReferenceService;
    const environmentAuth = yield* EnvironmentAuth;
    return handlers
      .handle(
        "listDeviceBindings",
        Effect.fn("environment.businessOs.listDeviceBindings")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessReadScope);
          yield* appendMobileInviteResponseHeaders;
          const bindings = yield* deviceInviteReferences
            .listBindings(args.payload.businessOsInstanceId)
            .pipe(
              Effect.catchTag("WorkjetDeviceInviteReferenceServiceError", () =>
                failEnvironmentInternal("device_invite_issuance_failed"),
              ),
            );
          return {
            devices: bindings.map((binding) => ({
              devicePairingId: binding.devicePairingId,
              deviceId: binding.deviceId,
              businessOsInstanceId: binding.businessOsInstanceId,
              pairedAtMillis: binding.createdAtMs,
            })),
          };
        }),
      )
      .handle(
        "createDeviceInvite",
        Effect.fn("environment.businessOs.createDeviceInvite")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* appendMobileInviteResponseHeaders;
          const connectionUrl = normalizeDeviceConnectionUrl(args.payload.connectionUrl);
          if (connectionUrl === null) {
            return yield* failEnvironmentInvalidRequest("invalid_device_connection_url");
          }
          const expiresAt = DateTime.formatIso(
            yield* DateTime.now.pipe(
              Effect.map(DateTime.add({ seconds: args.payload.ttlSeconds })),
            ),
          );
          const issued = yield* deviceInviteReferences
            .issue({
              endpoint: connectionUrl,
              expiresAt,
              businessOsInstanceId: args.payload.businessOsInstanceId,
            })
            .pipe(
              Effect.catchTag("WorkjetDeviceInviteReferenceServiceError", () =>
                failEnvironmentInternal("device_invite_issuance_failed"),
              ),
            );
          return {
            inviteId: issued.inviteId,
            expiresAt,
            reference: issued.reference,
          };
        }),
      )
      .handle(
        "revokeDeviceInvite",
        Effect.fn("environment.businessOs.revokeDeviceInvite")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* appendMobileInviteResponseHeaders;
          const revocation = yield* deviceInviteReferences
            .beginRevocation(args.payload.inviteId)
            .pipe(
              Effect.catchTag("WorkjetDeviceInviteReferenceServiceError", () =>
                failEnvironmentInternal("device_invite_revoke_failed"),
              ),
            );
          if (revocation._tag === "missing") {
            return { revoked: true as const };
          }
          if (revocation._tag === "pending") {
            return { revoked: true as const };
          }
          const revokeResults = yield* Effect.all(
            {
              workjet: Effect.exit(
                environmentAuth.revokePairingLink(revocation.binding.environmentPairingLinkId),
              ),
              ctox: Effect.exit(mobileInvites.revoke(revocation.binding.ctoxInviteId)),
            },
            { concurrency: "unbounded" },
          );
          if (Exit.isFailure(revokeResults.workjet) || Exit.isFailure(revokeResults.ctox)) {
            return yield* failEnvironmentInternal("device_invite_revoke_failed");
          }
          const finalized = yield* deviceInviteReferences
            .finalizeBindingRevocation(revocation.binding.devicePairingId)
            .pipe(
              Effect.catchTag("WorkjetDeviceInviteReferenceServiceError", () =>
                failEnvironmentInternal("device_invite_revoke_failed"),
              ),
            );
          if (!finalized) return yield* failEnvironmentInternal("device_invite_revoke_failed");
          return { revoked: true as const };
        }),
      )
      .handle(
        "redeemDeviceInvite",
        Effect.fn("environment.businessOs.redeemDeviceInvite")(function* (args) {
          yield* appendMobileInviteResponseHeaders;
          const intent = yield* deviceInviteReferences
            .consume({
              code: args.payload.code,
              rateLimitKey: deviceInviteRateLimitKey(args.request.source),
            })
            .pipe(
              Effect.catchTag(
                "WorkjetDeviceInviteReferenceServiceError",
                mapDeviceInviteReferenceError,
              ),
            );
          const now = yield* DateTime.now;
          const nowEpochMs = DateTime.toEpochMillis(now);
          const previousBinding = (yield* deviceInviteReferences
            .listBindings(intent.businessOsInstanceId)
            .pipe(
              Effect.catchTag("WorkjetDeviceInviteReferenceServiceError", () =>
                failEnvironmentInternal("device_invite_issuance_failed"),
              ),
            )).find((binding) => binding.deviceId === args.payload.deviceId);
          const remainingSeconds = Math.max(
            60,
            Math.min(3_600, Math.floor((intent.expiresAtMs - nowEpochMs) / 1_000)),
          );
          const workjetPairing = yield* environmentAuth
            .createPairingLink({
              ttl: Duration.seconds(remainingSeconds),
              scopes: AuthStandardClientScopes,
              subject: `workjet-device:${args.payload.deviceId}`,
              label: "Workjet device",
              proofKeyThumbprint: args.payload.proofKeyThumbprint,
            })
            .pipe(Effect.catch(() => failEnvironmentInternal("device_invite_issuance_failed")));
          const ctoxInvite = yield* mobileInvites.create(remainingSeconds).pipe(
            Effect.catchTag("CtoxMobileInviteServiceError", () =>
              Effect.gen(function* () {
                yield* environmentAuth.revokePairingLink(workjetPairing.id).pipe(Effect.ignore);
                return yield* failEnvironmentInternal("device_invite_issuance_failed");
              }),
            ),
          );
          if (ctoxInvite.invite.instance_id !== intent.businessOsInstanceId) {
            yield* Effect.all(
              [
                environmentAuth.revokePairingLink(workjetPairing.id).pipe(Effect.ignore),
                mobileInvites.revoke(ctoxInvite.inviteId).pipe(Effect.ignore),
              ],
              { concurrency: "unbounded" },
            );
            return yield* new WorkjetDeviceInviteRedeemRejectedError({
              code: "device_invite_unavailable",
            });
          }
          if (previousBinding !== undefined) {
            const previousRevokes = yield* Effect.all(
              {
                workjet: Effect.exit(
                  environmentAuth.revokePairingLink(previousBinding.environmentPairingLinkId),
                ),
                ctox: Effect.exit(mobileInvites.revoke(previousBinding.ctoxInviteId)),
              },
              { concurrency: "unbounded" },
            );
            if (Exit.isFailure(previousRevokes.workjet) || Exit.isFailure(previousRevokes.ctox)) {
              yield* Effect.all(
                [
                  environmentAuth.revokePairingLink(workjetPairing.id).pipe(Effect.ignore),
                  mobileInvites.revoke(ctoxInvite.inviteId).pipe(Effect.ignore),
                ],
                { concurrency: "unbounded" },
              );
              return yield* failEnvironmentInternal("device_invite_issuance_failed");
            }
          }
          const workjetExpiresAt = DateTime.formatIso(workjetPairing.expiresAt);
          const createdAtMs = nowEpochMs;
          yield* deviceInviteReferences
            .complete({
              devicePairingId: intent.inviteId,
              deviceId: args.payload.deviceId,
              proofKeyThumbprint: args.payload.proofKeyThumbprint,
              businessOsInstanceId: intent.businessOsInstanceId,
              environmentPairingLinkId: workjetPairing.id,
              ctoxInviteId: ctoxInvite.inviteId,
              createdAtMs,
            })
            .pipe(
              Effect.catchTag("WorkjetDeviceInviteReferenceServiceError", () =>
                Effect.gen(function* () {
                  yield* Effect.all(
                    [
                      environmentAuth.revokePairingLink(workjetPairing.id).pipe(Effect.ignore),
                      mobileInvites.revoke(ctoxInvite.inviteId).pipe(Effect.ignore),
                    ],
                    { concurrency: "unbounded" },
                  );
                  return yield* failEnvironmentInternal("device_invite_issuance_failed");
                }),
              ),
            );
          return {
            type: "workjet-device-invite" as const,
            version: 1 as const,
            device_pairing_id: intent.inviteId,
            environment: {
              base_url: intent.endpoint,
              bootstrap_credential: workjetPairing.credential,
              expires_at: workjetExpiresAt,
            },
            business_os: ctoxInvite.invite,
          };
        }),
      )
      .handle(
        "createMobileInvite",
        Effect.fn("environment.businessOs.createMobileInvite")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* appendMobileInviteResponseHeaders;
          return yield* mobileInvites
            .create(args.payload.ttlSeconds)
            .pipe(
              Effect.catchTag("CtoxMobileInviteServiceError", () =>
                failEnvironmentInternal("mobile_invite_issuance_failed"),
              ),
            );
        }),
      )
      .handle(
        "revokeMobileInvite",
        Effect.fn("environment.businessOs.revokeMobileInvite")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* appendMobileInviteResponseHeaders;
          return yield* mobileInvites
            .revoke(args.payload.inviteId)
            .pipe(
              Effect.catchTag("CtoxMobileInviteServiceError", () =>
                failEnvironmentInternal("mobile_invite_revoke_failed"),
              ),
            );
        }),
      )
      .handle(
        "resolveMobileShellPack",
        Effect.fn("environment.businessOs.resolveMobileShellPack")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessReadScope);
          yield* appendMobileInviteResponseHeaders;
          return yield* mobileShellPacks
            .resolve(args.payload.businessOsRevision, args.payload.appVersion)
            .pipe(
              Effect.catchTag("CtoxMobileShellPackServiceError", () =>
                failEnvironmentInternal("mobile_shell_pack_resolve_failed"),
              ),
            );
        }),
      );
  }),
);
