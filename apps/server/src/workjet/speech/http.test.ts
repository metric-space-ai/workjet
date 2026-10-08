// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentId,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
  type WorkjetSpeechRoute,
} from "@workjet/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpApiTest } from "effect/unstable/httpapi";

import { speechRouteHttpApiLayer } from "./http.ts";
import { WorkjetSpeechRouteStore } from "./WorkjetSpeechRouteStore.ts";

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

// SQL behaviour is covered by WorkjetSpeechRouteStore.test.ts; this file covers the HTTP surface.
const routes = new Map<string, WorkjetSpeechRoute>();
const storeLayer = Layer.succeed(
  WorkjetSpeechRouteStore,
  WorkjetSpeechRouteStore.of({
    list: Effect.sync(() => ({
      routes: (["regeltermin", "spontan"] as const).map(
        (sessionKind) =>
          routes.get(sessionKind) ?? {
            sessionKind,
            sttEnvironmentId: null,
            ttsEnvironmentId: null,
          },
      ),
    })),
    set: (route) =>
      Effect.sync(() => {
        routes.set(route.sessionKind, route);
        return route;
      }),
  }),
);

function clientFor(auth: typeof EnvironmentAuthenticatedAuth.Service) {
  return HttpApiTest.groups(EnvironmentHttpApi, ["speechRoutes"]).pipe(
    Effect.provide([
      NodeHttpServer.layerHttpServices,
      speechRouteHttpApiLayer.pipe(Layer.provide(storeLayer)),
    ]),
    Effect.provideService(EnvironmentAuthenticatedAuth, auth),
    Effect.scoped,
  );
}

describe("Workjet speech route HTTP", () => {
  it.effect("lists null defaults, then stores and reads back a per-kind selection", () =>
    Effect.gen(function* () {
      const client = yield* clientFor(authenticatedAuth(new Set(["access:read", "access:write"])));
      expect(yield* client.speechRoutes.listSpeechRoutes({ headers: {} })).toMatchObject({
        routes: [
          { sessionKind: "regeltermin", sttEnvironmentId: null, ttsEnvironmentId: null },
          { sessionKind: "spontan", sttEnvironmentId: null, ttsEnvironmentId: null },
        ],
      });
      yield* client.speechRoutes.setSpeechRoute({
        headers: {},
        payload: {
          sessionKind: "regeltermin",
          sttEnvironmentId: EnvironmentId.make("gpu-3"),
          ttsEnvironmentId: EnvironmentId.make("gpu-4"),
        },
      });
      const listed = yield* client.speechRoutes.listSpeechRoutes({ headers: {} });
      expect(listed.routes[0]).toEqual({
        sessionKind: "regeltermin",
        sttEnvironmentId: EnvironmentId.make("gpu-3"),
        ttsEnvironmentId: EnvironmentId.make("gpu-4"),
      });
    }),
  );

  it.effect("keeps the read-only scope from writing routes", () =>
    Effect.gen(function* () {
      const client = yield* clientFor(authenticatedAuth(new Set(["access:read"])));
      const failure = yield* client.speechRoutes
        .setSpeechRoute({
          headers: {},
          payload: { sessionKind: "spontan", sttEnvironmentId: null, ttsEnvironmentId: null },
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "EnvironmentScopeRequiredError" });
    }),
  );
});
