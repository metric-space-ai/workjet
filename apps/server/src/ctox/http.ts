// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  EnvironmentHttpApi,
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

export const MOBILE_INVITE_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
} as const;

const appendMobileInviteResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, MOBILE_INVITE_RESPONSE_HEADERS)),
);

type DeviceInviteIds = {
  readonly version: 1;
  readonly workjetPairingId: string;
  readonly ctoxInviteId: string;
};

export function encodeDeviceInviteId(ids: DeviceInviteIds): string {
  return Buffer.from(JSON.stringify(ids), "utf8").toString("base64url");
}

export function decodeDeviceInviteId(value: string): DeviceInviteIds | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<DeviceInviteIds>;
    return parsed.version === 1 &&
      typeof parsed.workjetPairingId === "string" &&
      parsed.workjetPairingId.length > 0 &&
      typeof parsed.ctoxInviteId === "string" &&
      parsed.ctoxInviteId.length > 0
      ? {
          version: 1,
          workjetPairingId: parsed.workjetPairingId,
          ctoxInviteId: parsed.ctoxInviteId,
        }
      : null;
  } catch {
    return null;
  }
}

export function normalizeDeviceConnectionUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
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

export const businessOsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "businessOs",
  Effect.fnUntraced(function* (handlers) {
    const mobileInvites = yield* CtoxMobileInviteService;
    const mobileShellPacks = yield* CtoxMobileShellPackService;
    const environmentAuth = yield* EnvironmentAuth;
    return handlers
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
          const workjetPairing = yield* environmentAuth
            .createPairingLink({
              ttl: Duration.seconds(args.payload.ttlSeconds),
              scopes: AuthStandardClientScopes,
              subject: "workjet-device",
              label: "Workjet mobile device",
            })
            .pipe(Effect.catch(() => failEnvironmentInternal("device_invite_issuance_failed")));
          const ctoxInvite = yield* mobileInvites.create(args.payload.ttlSeconds).pipe(
            Effect.catchTag("CtoxMobileInviteServiceError", () =>
              Effect.gen(function* () {
                yield* environmentAuth.revokePairingLink(workjetPairing.id).pipe(Effect.ignore);
                return yield* failEnvironmentInternal("device_invite_issuance_failed");
              }),
            ),
          );
          const workjetExpiresAt = DateTime.formatIso(workjetPairing.expiresAt);
          const expiresAt =
            Date.parse(workjetExpiresAt) <= Date.parse(ctoxInvite.expiresAt)
              ? workjetExpiresAt
              : ctoxInvite.expiresAt;
          return {
            inviteId: encodeDeviceInviteId({
              version: 1,
              workjetPairingId: workjetPairing.id,
              ctoxInviteId: ctoxInvite.inviteId,
            }),
            expiresAt,
            invite: {
              type: "workjet-device-invite" as const,
              version: 1 as const,
              device_pairing_id: workjetPairing.id,
              environment: {
                base_url: connectionUrl,
                bootstrap_credential: workjetPairing.credential,
                expires_at: workjetExpiresAt,
              },
              business_os: ctoxInvite.invite,
            },
          };
        }),
      )
      .handle(
        "revokeDeviceInvite",
        Effect.fn("environment.businessOs.revokeDeviceInvite")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* appendMobileInviteResponseHeaders;
          const ids = decodeDeviceInviteId(args.payload.inviteId);
          if (ids === null) {
            return yield* failEnvironmentInternal("device_invite_revoke_failed");
          }
          const revokeResults = yield* Effect.all(
            {
              workjet: Effect.exit(environmentAuth.revokePairingLink(ids.workjetPairingId)),
              ctox: Effect.exit(mobileInvites.revoke(ids.ctoxInviteId)),
            },
            { concurrency: "unbounded" },
          );
          if (Exit.isFailure(revokeResults.workjet) || Exit.isFailure(revokeResults.ctox)) {
            return yield* failEnvironmentInternal("device_invite_revoke_failed");
          }
          return { revoked: true as const };
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
