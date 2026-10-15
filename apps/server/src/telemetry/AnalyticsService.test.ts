// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { TestClock } from "effect/testing";

import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

const analyticsSource = NodeFS.readFileSync(
  new URL("./AnalyticsService.ts", import.meta.url),
  "utf8",
);

it.layer(NodeServices.layer)("AnalyticsService", (it) => {
  it.effect("never sends analytics, even with stored consent (owner rule 2026-10-15)", () => {
    const requests: string[] = [];
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          return HttpClientResponse.fromWeb(request, new Response("{}"));
        }),
      ),
    );
    return Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ posthogConsent: true });
      for (let index = 0; index < 45; index += 1) yield* analytics.record("server.started");
      yield* analytics.flush;
      yield* TestClock.adjust(5000);
      assert.deepEqual(requests, []);
    }).pipe(
      Effect.provide(Layer.mergeAll(AnalyticsService.layer, ServerSettings.layerTest(), httpLayer)),
    );
  });

  it("carries no PostHog key or endpoint", () => {
    assert.notInclude(analyticsSource, "posthog.com");
    assert.notInclude(analyticsSource, "phc_");
    assert.notInclude(analyticsSource, "HttpClient");
  });
});
