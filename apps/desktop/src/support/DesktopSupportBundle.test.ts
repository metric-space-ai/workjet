// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off - the fixture plants poisoned log
// and gateway files on a real temporary directory, which is the only way to
// exercise the collector's own filesystem boundary.
// @effect-diagnostics preferSchemaOverJson:off - the fixture writes foreign
// JSON documents verbatim and the assertions inspect the written artifact as
// raw text, which is exactly what a leak check has to look at.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  SUPPORT_BUNDLE_FIELD_INVENTORY,
  SUPPORT_BUNDLE_MAX_BYTES,
  SUPPORT_BUNDLE_MAX_LOG_LINES,
  SUPPORT_BUNDLE_PLACEHOLDERS,
  SupportBundleDocument,
  flattenSupportBundlePaths,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as DesktopAppIdentity from "../app/DesktopAppIdentity.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUserDataMigration from "../app/DesktopUserDataMigration.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopCrashReporting from "./DesktopCrashReporting.ts";
import * as DesktopSupportBundle from "./DesktopSupportBundle.ts";

const HOME_DIRECTORY = "/Users/canary";

/**
 * Poisoned inputs. Every one of these strings is planted in a place the
 * builder actually reads, and none of them may appear anywhere in the
 * written bundle.
 */
const PLANTED_SECRETS = [
  "sk-ant-api03-9zQx4Lm2Rt8Wv6Yb1Nc3Kd5Fg7Hj0Ps",
  "canary@example.com",
  "hunter2CorrectHorseBattery",
  "Ultra Secret Production Account",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.7Qk2Lm4Rt8Wv6Yb1Nc3Kd5",
  "please summarize the acquisition memo for the board",
] as const;

interface Fixture {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly logDir: string;
  readonly cleanup: () => void;
}

const makeFixture = (): Fixture => {
  const root = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "ctox-support-bundle-"));
  const stateDir = NodePath.join(root, "userdata");
  const logDir = NodePath.join(stateDir, "logs");
  NodeFs.mkdirSync(logDir, { recursive: true });

  NodeFs.writeFileSync(
    NodePath.join(stateDir, "provider-gateway.json"),
    JSON.stringify({
      schemaVersion: 1,
      defaultProvider: "claude",
      routingStrategy: "round-robin",
      accounts: [
        {
          id: "acct-1",
          label: "Ultra Secret Production Account",
          provider: "claude",
          enabled: true,
          priority: 10,
          weight: 3,
          models: ["claude-opus", "claude-sonnet"],
          accessTokenSecret: { scope: "workjet-provider-gateway", name: "acct-1-access" },
          refreshTokenSecret: { scope: "workjet-provider-gateway", name: "acct-1-refresh" },
        },
        {
          id: "acct-2",
          label: "canary@example.com",
          provider: "kimi",
          enabled: false,
          priority: 1,
          weight: 1,
          models: [],
          apiKeySecret: { scope: "workjet-provider-gateway", name: "acct-2-key" },
          credentialSuffix: "9Kd5",
        },
      ],
      pools: [{ id: "pool-1" }],
      routes: [{ id: "route-1" }, { id: "route-2" }],
    }),
  );
  NodeFs.writeFileSync(
    NodePath.join(stateDir, "provider-gateway-host.pid.json"),
    JSON.stringify({ schemaVersion: 1, pid: 4242 }),
  );

  const childLog = [
    JSON.stringify({
      message: "backend child process failure output start",
      level: "ERROR",
      timestamp: "2026-08-20T09:41:02.500Z",
      fiberId: "#backend-child",
      annotations: { component: "desktop-backend-child", phase: "START" },
      spans: {},
    }),
    JSON.stringify({
      message: "backend child process output",
      level: "ERROR",
      timestamp: "2026-08-20T09:41:03.500Z",
      fiberId: "#backend-child",
      annotations: {
        component: "desktop-backend-child",
        stream: "stdout",
        text: "please summarize the acquisition memo for the board -- Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.7Qk2Lm4Rt8Wv6Yb1Nc3Kd5 apiKey=sk-ant-api03-9zQx4Lm2Rt8Wv6Yb1Nc3Kd5Fg7Hj0Ps",
      },
      spans: {},
    }),
    JSON.stringify({
      message: "runtime logging configured /Users/canary/.t3/userdata/logs",
      level: "INFO",
      timestamp: "2026-08-20T09:41:04.500Z",
      annotations: { component: "desktop-startup" },
    }),
    "raw stdout line pairingPassword=hunter2CorrectHorseBattery",
  ].join("\n");
  NodeFs.writeFileSync(NodePath.join(logDir, "server-child.log"), `${childLog}\n`);

  const traceLines = Array.from({ length: SUPPORT_BUNDLE_MAX_LOG_LINES + 40 }, (_unused, index) =>
    JSON.stringify({ name: `desktop.span.number${index}`, traceId: `trace-${index}` }),
  ).join("\n");
  NodeFs.writeFileSync(NodePath.join(logDir, "desktop.trace.ndjson"), `${traceLines}\n`);
  NodeFs.writeFileSync(NodePath.join(logDir, "ignored.txt"), "not a log file\n");

  return {
    baseDir: root,
    stateDir,
    logDir,
    cleanup: () => NodeFs.rmSync(root, { recursive: true, force: true }),
  };
};

const desktopConfigLayer = (baseDir: string) => DesktopConfig.layerTest({ T3CODE_HOME: baseDir });

const appIdentityLayer = Layer.succeed(DesktopAppIdentity.DesktopAppIdentity, {
  resolveUserDataPath: Effect.succeed("/tmp/userdata"),
  commitHash: Effect.succeed(Option.some("a1b2c3d4e5f6")),
  configure: Effect.void,
} satisfies DesktopAppIdentity.DesktopAppIdentity["Service"]);

const crashReportingLayer = Layer.succeed(DesktopCrashReporting.DesktopCrashReporting, {
  configure: Effect.void,
  state: Effect.succeed({
    started: true,
    uploadToServer: false,
    metadata: {
      appVersion: "1.2.3",
      commitHash: "a1b2c3d4e5f6",
      platform: "darwin",
      arch: "arm64",
      channel: "latest",
      packaged: "true",
    },
  }),
} satisfies DesktopCrashReporting.DesktopCrashReporting["Service"]);

const migrationLayer = Layer.succeed(DesktopUserDataMigration.DesktopUserDataMigration, {
  decision: { _tag: "already-migrated", outcome: "migrated" },
  offer: Option.none(),
  accept: Effect.void,
  decline: Effect.void,
} satisfies DesktopUserDataMigration.DesktopUserDataMigration["Service"]);

const TEST_SETTINGS: DesktopAppSettings.DesktopSettings = {
  ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
  // A user-typed distro name must never reach the bundle.
  wslDistro: "canary@example.com",
  wslBackendEnabled: true,
};

const settingsLayer = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
  load: Effect.succeed(TEST_SETTINGS),
  get: Effect.succeed(TEST_SETTINGS),
  setMainWindowBounds: () => Effect.die("unexpected setMainWindowBounds"),
  setServerExposureMode: () => Effect.die("unexpected setServerExposureMode"),
  setTailscaleServe: () => Effect.die("unexpected setTailscaleServe"),
  setUpdateChannel: () => Effect.die("unexpected setUpdateChannel"),
  setWslBackendEnabled: () => Effect.die("unexpected setWslBackendEnabled"),
  setWslDistro: () => Effect.die("unexpected setWslDistro"),
  setWslOnly: () => Effect.die("unexpected setWslOnly"),
  applyWslWindowsFallback: Effect.die("unexpected applyWslWindowsFallback"),
  applyWslWindowsFallbackInMemory: Effect.die("unexpected applyWslWindowsFallbackInMemory"),
} satisfies DesktopAppSettings.DesktopAppSettings["Service"]);

const makeTestLayer = (fixture: Fixture) =>
  Layer.mergeAll(appIdentityLayer, crashReportingLayer, migrationLayer, settingsLayer).pipe(
    Layer.provideMerge(
      DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/dist-electron",
        homeDirectory: HOME_DIRECTORY,
        platform: "darwin",
        processArch: "arm64",
        appVersion: "1.2.3",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/repo/resources",
        runningUnderArm64Translation: false,
      }),
    ),
    Layer.provideMerge(desktopConfigLayer(fixture.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

type BundleUseError =
  | DesktopSupportBundle.DesktopSupportBundleWriteError
  | PlatformError.PlatformError;

const runBundle = <A>(
  use: (
    bundle: DesktopSupportBundle.DesktopSupportBundle["Service"],
    fixture: Fixture,
  ) => Effect.Effect<A, BundleUseError, FileSystem.FileSystem>,
): Promise<A> => {
  const fixture = makeFixture();
  return Effect.runPromise(
    Effect.gen(function* () {
      const bundle = yield* DesktopSupportBundle.make({
        runtimeVersions: {
          electron: "41.5.0",
          chrome: "140.0.0.0",
          node: "22.20.0",
          v8: "14.0.0",
        },
      });
      return yield* use(bundle, fixture);
    }).pipe(Effect.provide(makeTestLayer(fixture)), Effect.ensuring(Effect.sync(fixture.cleanup))),
  );
};

const assertNoPlantedSecret = (serialized: string): void => {
  for (const secret of PLANTED_SECRETS) {
    assert.isFalse(serialized.includes(secret), `support bundle leaked: ${secret}`);
  }
  assert.isFalse(serialized.includes("canary"), "support bundle leaked the home account name");
  assert.isFalse(serialized.includes("credentialSuffix"), "support bundle leaked a credential key");
};

describe("DesktopSupportBundle", () => {
  it("declares every field it emits", async () => {
    const document = await runBundle((bundle) => bundle.build);
    const produced = flattenSupportBundlePaths(document);
    const declared = new Set(SUPPORT_BUNDLE_FIELD_INVENTORY);

    const undeclared = [...produced].filter((path) => !declared.has(path)).sort();
    const unused = [...declared].filter((path) => !produced.has(path)).sort();

    assert.deepStrictEqual(
      undeclared,
      [],
      "the bundle emitted fields that SUPPORT_BUNDLE_FIELD_INVENTORY does not declare",
    );
    assert.deepStrictEqual(
      unused,
      [],
      "SUPPORT_BUNDLE_FIELD_INVENTORY declares fields the bundle no longer emits",
    );
  });

  it("decodes against the published schema", async () => {
    const document = await runBundle((bundle) => bundle.build);
    const decoded = Schema.decodeUnknownSync(SupportBundleDocument)(
      JSON.parse(JSON.stringify(document)),
    );
    assert.strictEqual(decoded.schemaVersion, 1);
    assert.strictEqual(decoded.uploadSupported, false);
    assert.strictEqual(decoded.features.crashReportUploadToServer, false);
  });

  it("carries no planted secret, label, prompt, or home path", async () => {
    const document = await runBundle((bundle) => bundle.build);
    assertNoPlantedSecret(JSON.stringify(document));
  });

  it("summarizes gateway accounts without labels or credential suffixes", async () => {
    const document = await runBundle((bundle) => bundle.build);
    const gateway = document.providerGateway;

    assert.isTrue(gateway.configurationPresent);
    assert.isTrue(gateway.configurationReadable);
    assert.isTrue(gateway.hostProcessRecorded);
    assert.strictEqual(gateway.routingStrategy, "round-robin");
    assert.strictEqual(gateway.accountCount, 2);
    assert.strictEqual(gateway.enabledAccountCount, 1);
    assert.strictEqual(gateway.poolCount, 1);
    assert.strictEqual(gateway.routeCount, 2);
    assert.strictEqual(gateway.accountHealth, "not-reported-by-host");
    assert.deepStrictEqual(
      gateway.accounts.map((account) => account.provider),
      ["claude", "kimi"],
    );
    assert.isTrue(gateway.accounts[0]?.hasCredentialReference);
    assert.strictEqual(gateway.accounts[0]?.modelCount, 2);
    for (const account of gateway.accounts) {
      assert.deepStrictEqual(Object.keys(account).sort(), [
        "enabled",
        "hasCredentialReference",
        "index",
        "modelCount",
        "priority",
        "provider",
        "weight",
      ]);
    }
  });

  it("reduces a user-typed WSL distro to a presence flag", async () => {
    const document = await runBundle((bundle) => bundle.build);
    assert.isTrue(document.features.wslDistroConfigured);
    assert.isFalse(JSON.stringify(document.features).includes("example.com"));
  });

  it("bounds log excerpts and names what it dropped", async () => {
    const document = await runBundle((bundle) => bundle.build);
    const names = document.logs.map((excerpt) => excerpt.fileName).sort();
    assert.deepStrictEqual(names, ["desktop.trace.ndjson", "server-child.log"]);

    const trace = document.logs.find((excerpt) => excerpt.fileName === "desktop.trace.ndjson");
    assert.isDefined(trace);
    assert.strictEqual(trace?.lines.length, SUPPORT_BUNDLE_MAX_LOG_LINES);
    assert.strictEqual(trace?.omittedLeadingLineCount, 40);

    const child = document.logs.find((excerpt) => excerpt.fileName === "server-child.log");
    assert.isDefined(child);
    // The unstructured stdout line is named-omitted, not silently dropped.
    assert.isTrue(child?.lines.includes(SUPPORT_BUNDLE_PLACEHOLDERS.unredactable));
    assert.strictEqual(child?.lines.length, 4);
  });

  it("counts what it redacted and omitted", async () => {
    const document = await runBundle((bundle) => bundle.build);
    assert.strictEqual(document.counters.logFileCount, 2);
    assert.strictEqual(document.counters.collectedLogFileCount, 2);
    assert.isAbove(document.counters.collectedLogLineCount, 0);
    assert.isAbove(document.counters.redactedFieldCount, 0);
    assert.isAbove(document.counters.omittedFieldCount, 0);
  });

  it("writes one inspectable file, reports its exact path, and stays within the size cap", async () => {
    const outcome = await runBundle((bundle) =>
      Effect.gen(function* () {
        const result = yield* bundle.create;
        const fileSystem = yield* FileSystem.FileSystem;
        const contents = yield* fileSystem.readFileString(result.filePath);
        return { result, contents };
      }),
    );

    assert.isTrue(outcome.result.filePath.endsWith(".json"));
    assert.include(outcome.result.filePath, "support-bundles");
    assert.strictEqual(Buffer.byteLength(outcome.contents, "utf8"), outcome.result.byteLength);
    assert.isAtMost(outcome.result.byteLength, SUPPORT_BUNDLE_MAX_BYTES + 1);
    assert.isAbove(outcome.result.fieldCount, 0);
    assertNoPlantedSecret(outcome.contents);

    const reparsed = Schema.decodeUnknownSync(SupportBundleDocument)(JSON.parse(outcome.contents));
    assert.strictEqual(reparsed.uploadSupported, false);
  });
});
