// @effect-diagnostics nodeBuiltinImport:off -- Isolated native child and Source/MCP HTTP fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@workjet/contracts";
import { HostProcessEnvironment } from "@workjet/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { BackgroundPolicy } from "../../background/BackgroundPolicy.ts";
import { ServerConfig, layerTest as configLayerTest } from "../../config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { clearMcpProviderSession, setMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { ProviderGatewayService } from "../../providerGateway/ProviderGatewayService.ts";
import { layerTest as settingsLayerTest } from "../../serverSettings.ts";
import { installWorkerSourceRoute } from "../../workjet/WorkerSourceHarness.ts";
import { PI_WORKJET_EXTENSION } from "../pi/PiWorkjetExtension.ts";
import { PiDriver } from "./PiDriver.ts";

const instanceId = ProviderInstanceId.make("pi-fresh-source");
const threadId = ThreadId.make("pi-fresh-source-worker");
const modelSelection = { instanceId, model: "gpt-6.1-sol" };
const executable = NodeURL.fileURLToPath(new URL("../testFixtures/piRpcCli.mjs", import.meta.url));
const decodeWire = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      operation: Schema.optional(Schema.String),
      id: Schema.optional(Schema.Number),
      method: Schema.optional(Schema.String),
      params: Schema.optional(
        Schema.Struct({
          name: Schema.optional(Schema.String),
          arguments: Schema.optional(Schema.Struct({ command: Schema.String })),
        }),
      ),
    }),
  ),
);
const decodeStartup = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      extensionPath: Schema.String,
      loadedTools: Schema.Array(Schema.String),
      agentDirectory: Schema.String,
      sourceIsolated: Schema.Boolean,
      targetSecretPresent: Schema.Boolean,
    }),
  ),
);

it.effect("loads MCP tools on a fresh admitted Source start without a target-local gateway", () =>
  Effect.gen(function* () {
    const environment = yield* HostProcessEnvironment;
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(environment.TMPDIR || NodeOS.tmpdir(), "pi-source-driver-")),
      ),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    let admissions = 0;
    const calls: Array<{ name?: string; arguments?: { command: string } }> = [];
    const server = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const server = NodeHttp.createServer(async (request, response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const message = decodeWire(Buffer.concat(chunks).toString());
          if (message.operation === "admit") {
            expect(request.headers.authorization).toBe("Bearer admission-capability");
            admissions++;
            response.writeHead(200, { "content-type": "application/json" }).end("{}");
            return;
          }
          expect(request.headers.authorization).toBe("Bearer pi-mcp-fixture");
          if (message.method === "notifications/initialized") {
            response.writeHead(202).end();
            return;
          }
          let result: unknown;
          if (message.method === "initialize") {
            result = {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "pi-driver-fixture", version: "1" },
            };
          } else if (message.method === "tools/list") {
            result = {
              tools: [{
                name: "workjet_fixture_echo",
                inputSchema: {
                  type: "object",
                  properties: { command: { type: "string" } },
                  required: ["command"],
                },
              }],
            };
          } else {
            expect(message.method).toBe("tools/call");
            expect(message.params?.name).toBe("workjet_fixture_echo");
            calls.push(message.params!);
            result = { content: [{ type: "text", text: message.params?.arguments?.command }] };
          }
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
          );
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        return server;
      }),
      (server) => Effect.promise(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No Source fixture listener.");
    const sourceDirectory = NodePath.join(directory, "original-source-profile");
    yield* Effect.promise(() => NodeFSP.mkdir(sourceDirectory, { mode: 0o700 }));
    const route = yield* Effect.acquireRelease(
      Effect.promise(() => installWorkerSourceRoute(threadId, {
        sourceEnvironmentId: "original-source",
        targetEnvironmentId: "target-worker",
        requestId: threadId,
        requestDigest: "pi-source-digest",
        capability: "admission-capability",
        port: address.port,
      }, {
        targetEnvironmentId: "target-worker",
        requestDigest: "pi-source-digest",
        modelId: modelSelection.model,
        harness: "pi-code",
        nativeProfile: { harness: "pi-code", directory: sourceDirectory },
      })),
      (route) => Effect.promise(() => route.revoke()),
    );
    const initialAdmissions = admissions;
    setMcpProviderSession({
      environmentId: EnvironmentId.make("target-worker"),
      threadId,
      providerSessionId: "pi-source-session",
      providerInstanceId: instanceId,
      endpoint: `http://127.0.0.1:${address.port}/mcp`,
      authorizationHeader: "Bearer pi-mcp-fixture",
      activeWorkjetMcpCapabilityIds: [],
      compiledManagedPrompt: "Use the admitted Source tools.",
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => clearMcpProviderSession(threadId)));
    yield* Effect.gen(function* () {
      const config = yield* ServerConfig;
      const profileDirectory = NodePath.join(config.stateDir, "harness-gateway-profiles", "pi", instanceId);
      expect(yield* Effect.promise(() => NodeFSP.access(profileDirectory).then(() => true, () => false))).toBe(false);
      const provider = yield* PiDriver.create({
        instanceId,
        displayName: undefined,
        environment: [{ name: "WORKJET_PI_TEST_TARGET_SECRET", value: "target-private", sensitive: true }],
        enabled: true,
        routeViaGateway: false,
        config: { ...PiDriver.defaultConfig(), binaryPath: executable },
      });
      const extensionPath = NodePath.join(profileDirectory, "workjet-extension.mjs");
      expect(yield* Effect.promise(() => NodeFSP.readFile(extensionPath, "utf8"))).toBe(PI_WORKJET_EXTENSION);
      expect((yield* Effect.promise(() => NodeFSP.stat(extensionPath))).mode & 0o777).toBe(0o600);
      const completed = yield* provider.adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "item.completed"),
        Stream.take(20), Stream.runCollect, Effect.forkChild({ startImmediately: true }),
      );
      yield* provider.adapter.startSession({
        threadId, cwd: directory, runtimeMode: "full-access", modelSelection,
        workjetConfig: {
          ...DEFAULT_WORKJET_THREAD_CONFIG,
          role: "worker",
          parent: { environmentId: EnvironmentId.make("original-source"), threadId: ThreadId.make("parent") },
        },
      });
      const startup = decodeStartup(yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(sourceDirectory, "sessions", "fixture-startup.json"), "utf8")));
      expect(startup).toEqual({ extensionPath, loadedTools: ["workjet_fixture_echo"], agentDirectory: sourceDirectory, sourceIsolated: true, targetSecretPresent: false });
      yield* provider.adapter.sendTurn({ threadId, input: "RUN_WORKJET_MCP", modelSelection });
      const results = yield* Fiber.join(completed);
      expect(results).toHaveLength(20);
      expect(results.every((event) => event.type === "item.completed" && event.payload.status === "completed")).toBe(true);
      expect(calls).toEqual(Array.from({ length: 20 }, (_, index) => ({ name: "workjet_fixture_echo", arguments: { command: `result-${index + 1}` } })));
      expect(admissions - initialAdmissions).toBe(2);
      expect(yield* Effect.promise(() => NodeFSP.access(NodePath.join(profileDirectory, "models.json")).then(() => true, () => false))).toBe(false);
      expect((yield* provider.adapter.stopSession(threadId))?.terminated).toBe(true);
      expect(route.nativeProfile?.environment.PI_CODING_AGENT_DIR).toBe(sourceDirectory);
    }).pipe(Effect.provide(Layer.mergeAll(
      configLayerTest(directory, NodePath.join(directory, "server-state")),
      settingsLayerTest(),
      Layer.mock(BackgroundPolicy, { shouldRunScopeWork: () => Effect.succeed(false) }),
      Layer.mock(ProviderGatewayService, {
        catalog: () => Effect.succeed({ schemaVersion: 1, accounts: [], pools: [], routes: [], models: [], routingStrategy: "round-robin", providerPools: [] }),
        status: () => Effect.succeed({ schemaVersion: 1, phase: "stopped", pid: null, providerEndpoint: null, managementEndpoint: null, failureReason: null, configuredAccountCount: 0, configuredModelCount: 0 }),
      }),
      Layer.mock(ServerEnvironment, { getEnvironmentId: Effect.succeed(EnvironmentId.make("target-worker")) }),
    )));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
