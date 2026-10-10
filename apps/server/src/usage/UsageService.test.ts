import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { UsageDay } from "@workjet/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";
import catalog from "./catalog/model-rates.json" with { type: "json" };
import { parseRateTable, priceUsage } from "./usagePricing.ts";

it.layer(NodeServices.layer)("bundled usage pricing", (it) => {
  it.effect(
    "starts and reads cold, warm and after seven days without HTTP; ignores legacy external rates",
    () => {
      const requests: string[] = [];
      const runtime = UsageService.layer.pipe(
        Layer.provideMerge(ServerSettings.layerTest()),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "workjet-offline-usage-" }),
        ),
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              requests.push(request.url);
              return Effect.die("Unexpected pricing HTTP request");
            }),
          ),
        ),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      );
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const settings = yield* ServerSettings.ServerSettingsService;
        const usage = yield* UsageService.UsageService;
        const home = path.join(config.baseDir, "claude");
        const transcriptDir = path.join(home, "projects", "fixture");
        yield* fileSystem.makeDirectory(transcriptDir, { recursive: true });
        yield* settings.updateSettings({
          providers: {
            claudeAgent: { homePath: home },
            codex: { homePath: path.join(config.baseDir, "codex") },
          },
        });
        const rates = parseRateTable(catalog.document);
        const knownModel = Object.keys(catalog.document)[0]!;
        const unknownModel = catalog.liveCatalog.providers
          .flatMap((provider) => provider.models)
          .find((model) => !rates.has(model.toLowerCase()))!;
        assert.equal(typeof unknownModel, "string");
        yield* fileSystem.writeFileString(
          path.join(config.stateDir, "usage-model-rates.json"),
          JSON.stringify({
            fetchedAtMs: 0,
            document: {
              [knownModel]: {
                input_cost_per_token: 100,
                output_cost_per_token: 100,
              },
            },
          }),
        );
        yield* fileSystem.writeFileString(
          path.join(transcriptDir, "session.jsonl"),
          [knownModel, unknownModel]
            .map((model, index) =>
              JSON.stringify({
                type: "assistant",
                timestamp: "2026-10-10T12:00:00.000Z",
                sessionId: "offline-fixture",
                message: {
                  id: `message-${index}`,
                  model,
                  role: "assistant",
                  content: [{ type: "text" }],
                  usage: { input_tokens: 100, output_tokens: 50 },
                },
              }),
            )
            .join("\n") + "\n",
        );
        const input = {
          sinceDay: UsageDay.make("2026-10-10"),
          untilDay: UsageDay.make("2026-10-10"),
          timeZone: "UTC",
        };
        for (const advance of [0, 0, 7 * 24 * 60 * 60 * 1000]) {
          yield* TestClock.adjust(advance);
          const summary = yield* usage.readSummary(input);
          assert.equal(summary.pricing.source, `bundled:${catalog.version}`);
          assert.equal(summary.pricing.knownModels, rates.size);
          assert.equal(summary.pricing.fetchedAt, catalog.checkedAt);
          const known = summary.buckets.find((bucket) => bucket.model === knownModel)!;
          const unknown = summary.buckets.find((bucket) => bucket.model === unknownModel)!;
          assert.equal(known.costSource, "modelPriced");
          assert.equal(known.costUsd, priceUsage(rates, knownModel, known.totals, null).costUsd);
          assert.equal(unknown.costSource, "unpriced");
          assert.equal(unknown.unpricedRecords, 1);
          assert.equal(unknown.totals.uncachedInputTokens, 100);
        }
      }).pipe(
        Effect.provide(runtime),
        Effect.tap(() => Effect.sync(() => assert.deepEqual(requests, []))),
      );
    },
  );
});
