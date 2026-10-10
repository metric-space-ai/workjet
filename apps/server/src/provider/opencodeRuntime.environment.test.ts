// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

const fixture = `#!/usr/bin/env node
import http from "node:http";
const server = http.createServer((_req, res) => {
  res.writeHead(200, {"content-type":"application/json"});
  res.end(JSON.stringify({configuration:process.env.OPENCODE_CONFIG_CONTENT}));
});
server.listen(0,"127.0.0.1",()=>console.log("opencode server listening on http://127.0.0.1:"+server.address().port));
`;

const observeSpawnedConfiguration = (environment?: NodeJS.ProcessEnv) =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "opencode-env-"))),
        (directory) => Effect.promise(() => NodeFS.rm(directory, { recursive: true, force: true })),
      );
      const binaryPath = NodePath.join(directory, "opencode-fixture.mjs");
      yield* Effect.promise(() => NodeFS.writeFile(binaryPath, fixture, { mode: 0o700 }));
      const runtime = yield* OpenCodeRuntime;
      const server = yield* runtime.startOpenCodeServerProcess({
        binaryPath,
        ...(environment === undefined ? {} : { environment }),
      });
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.get(server.url).pipe(Effect.flatMap((response) => response.text));
      const parsed = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ configuration: Schema.String })),
      )(response);
      return parsed.configuration;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(OpenCodeRuntimeLive.pipe(Layer.provide(NodeServices.layer)), FetchHttpClient.layer),
      ),
    ),
  );

it.effect("passes explicit gateway model configuration to the native child", () =>
  Effect.gen(function* () {
    const configuration =
      '{"provider":{"workjet-gateway-claude":{"npm":"@ai-sdk/openai","models":{"claude-opus-5-5":{"name":"Opus"}}}}}';
    const observed = yield* observeSpawnedConfiguration({
      ...process.env,
      OPENCODE_CONFIG_CONTENT: configuration,
    });
    NodeAssert.equal(observed, configuration);
  }),
);

it.effect("retains the empty legacy default when no environment is supplied", () =>
  Effect.gen(function* () {
    const observed = yield* observeSpawnedConfiguration();
    NodeAssert.equal(observed, "{}");
  }),
);
