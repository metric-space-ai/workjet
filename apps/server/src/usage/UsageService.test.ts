import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { UsageDay } from "@workjet/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";
import catalog from "./catalog/model-rates.json" with { type: "json" };
import { parseRateTable, priceUsage } from "./usagePricing.ts";

const encodeFixtureJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("bundled usage pricing", (it) => {
  it.effect(
    "starts and reads cold, warm and after seven days without HTTP; ignores legacy external rates",
    () => {
      const requests: string[] = [];
      const runtime = UsageService.layer.pipe(
        Layer.provideMerge(ServerSettings.layerTest()),
        Layer.provideMerge(SqlitePersistenceMemory),
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
          encodeFixtureJson({
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
              encodeFixtureJson({
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
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at, workjet_config_json) VALUES
          ('known-worker', 'usage-project', 'Known worker', '{}', '2026-10-10T10:00:00Z', '2026-10-10T10:00:00Z', '{"team":{"role":"worker"}}'),
          ('unknown-supervisor', 'usage-project', 'Unknown supervisor', '{}', '2026-10-10T10:00:00Z', '2026-10-10T10:00:00Z', '{"team":{"role":"supervisor"}}'),
          ('no-turns', 'usage-project', 'No turns', '{}', '2026-10-10T10:00:00Z', '2026-10-10T10:00:00Z', '{}')`;
        yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, provider_name, updated_at)
          VALUES ('known-worker', 'ready', 'claudeAgent', '2026-10-10T10:00:00Z')`;
        yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json)
          VALUES ('known-worker', 'claudeAgent', 'claudeAgent', 'ready', '2026-10-10T10:00:00Z', '{"resume":"offline-fixture"}')`;
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
          VALUES ('unknown-supervisor', 'missing-turn', 'completed', '2026-10-10T13:00:00Z', '[]')`;
        const projectSummary = yield* usage.readSummary({
          projectId: "usage-project",
          sinceDay: UsageDay.make("2026-10-10"),
          untilDay: UsageDay.make("2026-10-17"),
          sinceTime: "2026-10-10T12:00:00Z",
          untilTime: "2026-10-17T12:00:00Z",
          timeZone: "UTC",
        });
        assert.equal(projectSummary.buckets.length, 2);
        assert.isTrue(
          projectSummary.buckets.every(
            (bucket) => bucket.threadId === "known-worker" && bucket.role === "worker",
          ),
        );
        assert.deepEqual(
          projectSummary.projectThreads?.map((thread) => [thread.threadId, thread.status]),
          [
            ["known-worker", "measured"],
            ["unknown-supervisor", "unknown"],
            ["no-turns", "no-turns"],
          ],
        );
        // Changing harness and deleting its runtime must retain already consumed project usage.
        yield* sql`UPDATE provider_session_runtime SET provider_name = 'codex', resume_cursor_json = '{"threadId":"next-session"}' WHERE thread_id = 'known-worker'`;
        yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = 'known-worker'`;
        yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = 'known-worker'`;
        yield* sql`UPDATE projection_threads SET archived_at = '2026-10-11T00:00:00Z' WHERE thread_id = 'known-worker'`;
        const afterCleanup = yield* usage.readSummary({
          projectId: "usage-project",
          sinceDay: UsageDay.make("2026-10-10"),
          untilDay: UsageDay.make("2026-10-17"),
          sinceTime: "2026-10-10T12:00:00Z",
          untilTime: "2026-10-17T12:00:00Z",
          timeZone: "UTC",
        });
        assert.deepEqual(afterCleanup.buckets, projectSummary.buckets);
        const recordAssistantUsage = usage.recordAssistantUsage;
        if (!recordAssistantUsage) throw new Error("Usage observation writer is unavailable");
        for (let copy = 0; copy < 2; copy++)
          yield* recordAssistantUsage({
            threadId: "known-worker",
            sessionId: "sdk-fixture-session",
            messageId: "sdk-message",
            model: knownModel,
            createdAt: "2026-10-10T12:01:00Z",
            usage: { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 10 },
          });
        const sdkUsage = yield* usage.readSummary({
          projectId: "usage-project",
          sinceDay: UsageDay.make("2026-10-10"),
          untilDay: UsageDay.make("2026-10-17"),
          timeZone: "UTC",
        });
        assert.equal(
          sdkUsage.buckets.reduce((sum, bucket) => sum + bucket.records, 0),
          3,
        );
        assert.equal(
          sdkUsage.buckets.reduce(
            (sum, bucket) =>
              sum +
              bucket.totals.uncachedInputTokens +
              bucket.totals.cachedInputTokens +
              bucket.totals.outputTokens,
            0,
          ),
          355,
        );
        const boundary = yield* usage.readSummary({
          projectId: "usage-project",
          sinceDay: UsageDay.make("2026-10-03"),
          untilDay: UsageDay.make("2026-10-10"),
          sinceTime: "2026-10-03T12:00:00Z",
          untilTime: "2026-10-10T12:00:00Z",
          timeZone: "UTC",
        });
        assert.deepEqual(boundary.buckets, []);
        const foreign = yield* usage.readSummary({
          projectId: "foreign-project",
          sinceDay: UsageDay.make("2026-10-10"),
          untilDay: UsageDay.make("2026-10-10"),
          timeZone: "UTC",
        });
        assert.deepEqual(foreign.buckets, []);
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
