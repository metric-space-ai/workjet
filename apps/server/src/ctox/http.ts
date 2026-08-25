// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { AuthAccessWriteScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { CtoxMobileInviteService } from "./CtoxMobileInviteService.ts";

export const MOBILE_INVITE_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
} as const;

const appendMobileInviteResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, MOBILE_INVITE_RESPONSE_HEADERS)),
);

export const businessOsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "businessOs",
  Effect.fnUntraced(function* (handlers) {
    const mobileInvites = yield* CtoxMobileInviteService;
    return handlers
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
      );
  }),
);
