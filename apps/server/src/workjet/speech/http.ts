// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  WorkjetSpeechRouteHttpApi,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import { WorkjetSpeechRouteStore } from "./WorkjetSpeechRouteStore.ts";

export const WORKJET_SPEECH_ROUTE_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
} as const;

const appendSpeechRouteResponseHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, WORKJET_SPEECH_ROUTE_RESPONSE_HEADERS)),
);

export const speechRouteHttpApiLayer = HttpApiBuilder.group(
  WorkjetSpeechRouteHttpApi,
  "speechRoutes",
  Effect.fnUntraced(function* (handlers) {
    const store = yield* WorkjetSpeechRouteStore;
    return handlers
      .handle(
        "list",
        Effect.fn("environment.speechRoutes.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessReadScope);
          yield* appendSpeechRouteResponseHeaders;
          return yield* store.list.pipe(
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
          );
        }),
      )
      .handle(
        "set",
        Effect.fn("environment.speechRoutes.set")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* appendSpeechRouteResponseHeaders;
          return yield* store
            .set(args.payload)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }),
      );
  }),
);
