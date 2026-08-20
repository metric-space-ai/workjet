import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, WorkjetGatewayAccountId } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import {
  layerTest as serverSettingsLayerTest,
  ServerSettingsService,
} from "../../serverSettings.ts";
import {
  decideLegacyWorkjetImport,
  LEGACY_WORKJET_IMPORT_MARKER_FILE,
  LegacyWorkjetImport,
  layer as legacyWorkjetImportLayer,
  legacyWorkjetConfigCandidatePaths,
  readAndMapLegacyWorkjetConfig,
  type LegacyWorkjetImportMarker,
} from "./LegacyWorkjetImport.ts";
import { EMPTY_LEGACY_WORKJET_BINDINGS } from "./LegacyWorkjetMapping.ts";
import goldenSample from "./testFixtures/legacyWorkjetConfig.v1.json" with { type: "json" };

/**
 * The runner consumes file TEXT, so the fixture is re-serialized here. Both the
 * reader and the mapping are exercised against the parsed document in their own
 * suites; what this suite adds is the filesystem round trip.
 */
const encodeDocument = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const marker = (overrides: Partial<LegacyWorkjetImportMarker> = {}): LegacyWorkjetImportMarker => ({
  version: 1,
  outcome: "imported",
  legacyPath: "/home/me/Library/Application Support/Workjet/config.v1.json",
  decidedAt: "2026-01-01T00:00:00.000Z",
  legacyVersion: 1,
  importedComputers: 0,
  importedLlmRoutes: 0,
  importedWorkerProfiles: 0,
  pendingBindings: 0,
  ...overrides,
});

describe("decideLegacyWorkjetImport", () => {
  it("reports a fresh environment when no legacy configuration exists", () => {
    assert.deepEqual(
      decideLegacyWorkjetImport({
        marker: Option.none(),
        candidates: [
          { path: "/home/me/Library/Application Support/Workjet/config.v1.json", exists: false },
        ],
      }),
      { _tag: "fresh" },
    );
    assert.deepEqual(decideLegacyWorkjetImport({ marker: Option.none(), candidates: [] }), {
      _tag: "fresh",
    });
  });

  it("offers the first existing candidate, in order", () => {
    assert.deepEqual(
      decideLegacyWorkjetImport({
        marker: Option.none(),
        candidates: [
          { path: "/a/config.v1.json", exists: false },
          { path: "/b/config.v1.json", exists: true },
          { path: "/c/config.v1.json", exists: true },
        ],
      }),
      { _tag: "import-offer", legacyPath: "/b/config.v1.json" },
    );
  });

  it("lets a recorded decision win, including a decline", () => {
    for (const outcome of ["imported", "declined"] as const) {
      assert.deepEqual(
        decideLegacyWorkjetImport({
          marker: Option.some(marker({ outcome })),
          candidates: [{ path: "/a/config.v1.json", exists: true }],
        }),
        { _tag: "already-decided", outcome },
      );
    }
  });
});

describe("legacyWorkjetConfigCandidatePaths", () => {
  const join = (first: string, ...rest: string[]): string => [first, ...rest].join("/");

  it("looks in the macOS application-support directory", () => {
    assert.deepEqual(
      [
        ...legacyWorkjetConfigCandidatePaths({
          homeDirectory: "/Users/me",
          platform: "darwin",
          join,
        }),
      ],
      ["/Users/me/Library/Application Support/Workjet/config.v1.json"],
    );
  });

  it("has no candidate where the Swift menu-bar app cannot run", () => {
    for (const platform of ["linux", "win32"] as const) {
      assert.deepEqual(
        [...legacyWorkjetConfigCandidatePaths({ homeDirectory: "/Users/me", platform, join })],
        [],
      );
    }
    assert.deepEqual(
      [...legacyWorkjetConfigCandidatePaths({ homeDirectory: "  ", platform: "darwin", join })],
      [],
    );
  });
});

const HOME = "/Users/me";
const LEGACY_PATH = `${HOME}/Library/Application Support/Workjet/config.v1.json`;
const STATE_DIR = "/state/userdata";
const SETTINGS_PATH = `${STATE_DIR}/settings.json`;
const MARKER_PATH = `${STATE_DIR}/${LEGACY_WORKJET_IMPORT_MARKER_FILE}`;

interface FakeDisk {
  readonly files: Map<string, string>;
  readonly writes: string[];
}

const makeDisk = (files: Record<string, string> = {}): FakeDisk => ({
  files: new Map(Object.entries(files)),
  writes: [],
});

const makeImportLayer = (disk: FakeDisk) => {
  const fileSystem = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(disk.files.has(path)),
    makeDirectory: () => Effect.void,
    readFileString: (path) => {
      const contents = disk.files.get(path);
      return contents === undefined
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              description: "missing",
              pathOrDescriptor: path,
            }),
          )
        : Effect.succeed(contents);
    },
    writeFileString: (path, data) =>
      Effect.sync(() => {
        disk.writes.push(path);
        disk.files.set(path, data);
      }),
  });

  const serverConfig = ServerConfig.layer({
    stateDir: STATE_DIR,
    settingsPath: SETTINGS_PATH,
  } as unknown as ServerConfig.ServerConfig["Service"]);

  const settings = serverSettingsLayerTest();

  return legacyWorkjetImportLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(serverConfig, settings, fileSystem, Path.layer)),
    Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
    Layer.provide(Layer.succeed(HostProcessEnvironment, { HOME } as NodeJS.ProcessEnv)),
  );
};

const goldenText = encodeDocument(goldenSample);

const BINDINGS = {
  environmentByComputerId: {
    "00000000-0000-0000-0000-000000000001": EnvironmentId.make("env-local"),
  },
  gatewayAccountByProviderId: {
    "14F384A7-0D3F-45D1-9CF9-8962A3B28739": WorkjetGatewayAccountId.make("zai-z.ai-key"),
  },
  gatewayAccountByProviderPool: {},
};

describe("LegacyWorkjetImport against a fake filesystem", () => {
  it("offers once and previews the honest floor before any binding", () => {
    const disk = makeDisk({ [LEGACY_PATH]: goldenText });

    return Effect.gen(function* () {
      const importer = yield* LegacyWorkjetImport;
      assert.deepEqual(importer.decision, { _tag: "import-offer", legacyPath: LEGACY_PATH });
      assert.isTrue(Option.isSome(importer.offer));
      if (Option.isNone(importer.offer)) return;

      const offer = importer.offer.value;
      assert.strictEqual(offer.settingsPath, SETTINGS_PATH);
      assert.strictEqual(offer.preview._tag, "mapped");
      if (offer.preview._tag !== "mapped") return;
      // No bindings: nothing that needs an invented reference comes across.
      assert.strictEqual(offer.preview.result.counts.computersImported, 0);
      assert.strictEqual(offer.preview.result.counts.workersImported, 0);
      assert.isAbove(offer.preview.result.pending.length, 0);
      // Reading the offer must not write anything at all.
      assert.deepEqual(disk.writes, []);
    }).pipe(Effect.provide(makeImportLayer(disk)), Effect.scoped);
  });

  it("has nothing to offer when the machine never ran the Swift app", () => {
    const disk = makeDisk();
    return Effect.gen(function* () {
      const importer = yield* LegacyWorkjetImport;
      assert.deepEqual(importer.decision, { _tag: "fresh" });
      assert.isTrue(Option.isNone(importer.offer));
      assert.deepEqual(yield* importer.accept(EMPTY_LEGACY_WORKJET_BINDINGS), { _tag: "fresh" });
      assert.deepEqual(disk.writes, []);
    }).pipe(Effect.provide(makeImportLayer(disk)), Effect.scoped);
  });

  it("still offers a document that fails closed, and refuses to import it", () => {
    const futureText = encodeDocument({ ...goldenSample, version: 2 });
    const disk = makeDisk({ [LEGACY_PATH]: futureText });

    return Effect.gen(function* () {
      const importer = yield* LegacyWorkjetImport;
      assert.isTrue(Option.isSome(importer.offer));
      if (Option.isNone(importer.offer)) return;
      assert.strictEqual(importer.offer.value.preview._tag, "unreadable");

      const result = yield* importer.accept(EMPTY_LEGACY_WORKJET_BINDINGS);
      assert.strictEqual(result._tag, "unreadable");
      if (result._tag !== "unreadable") return;
      assert.strictEqual(result.failure.reason, "unsupported-version");
      // No marker: an unreadable document is a defect to look at, not a decision.
      assert.deepEqual(disk.writes, []);
      assert.isFalse(disk.files.has(MARKER_PATH));
      // And the legacy document is untouched.
      assert.strictEqual(disk.files.get(LEGACY_PATH), futureText);
    }).pipe(Effect.provide(makeImportLayer(disk)), Effect.scoped);
  });

  it("writes the settings once, records the marker, and never runs twice", () => {
    const disk = makeDisk({ [LEGACY_PATH]: goldenText });

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const importer = yield* LegacyWorkjetImport;
          const settings = yield* ServerSettingsService;

          const first = yield* importer.accept(BINDINGS);
          assert.strictEqual(first._tag, "imported");
          if (first._tag !== "imported") return;
          assert.strictEqual(first.configuration.computers.length, 1);
          assert.strictEqual(first.configuration.llmRoutes.length, 1);
          assert.strictEqual(first.configuration.workerProfiles.length, 1);

          const stored = yield* settings.getSettings;
          assert.strictEqual(stored.workjet.workerProfiles[0]?.name, "Prototype C · GLM");
          assert.include(stored.workjet.managedSystemPrompt, "## Progress board");

          // Idempotent: a second accept is a no-op against the settings store.
          const second = yield* importer.accept(BINDINGS);
          assert.deepEqual(second, { _tag: "already-decided", outcome: "imported" });
        }).pipe(Effect.provide(makeImportLayer(disk))),
      );

      const written = disk.files.get(MARKER_PATH);
      assert.isDefined(written);
      assert.include(written, '"outcome":"imported"');
      assert.include(written, '"importedWorkerProfiles":1');
      assert.strictEqual(
        disk.writes.filter((path) => path === MARKER_PATH).length,
        1,
        "the marker is written exactly once",
      );
      // The legacy document is never written, moved, or removed.
      assert.notInclude(disk.writes, LEGACY_PATH);
      assert.strictEqual(disk.files.get(LEGACY_PATH), goldenText);

      // A later launch sees the terminal marker and offers nothing.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const importer = yield* LegacyWorkjetImport;
          assert.deepEqual(importer.decision, { _tag: "already-decided", outcome: "imported" });
          assert.isTrue(Option.isNone(importer.offer));
        }).pipe(Effect.provide(makeImportLayer(disk))),
      );
    });
  });

  it("records a decline and never offers again", () => {
    const disk = makeDisk({ [LEGACY_PATH]: goldenText });

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const importer = yield* LegacyWorkjetImport;
          yield* importer.decline;
          // Declining twice must not rewrite the record.
          yield* importer.decline;
        }).pipe(Effect.provide(makeImportLayer(disk))),
      );

      const written = disk.files.get(MARKER_PATH);
      assert.isDefined(written);
      assert.include(written, '"outcome":"declined"');
      assert.strictEqual(disk.writes.filter((path) => path === MARKER_PATH).length, 1);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const importer = yield* LegacyWorkjetImport;
          const settings = yield* ServerSettingsService;
          assert.deepEqual(importer.decision, { _tag: "already-decided", outcome: "declined" });
          assert.isTrue(Option.isNone(importer.offer));
          // A declined environment that calls accept anyway stays declined.
          assert.deepEqual(yield* importer.accept(BINDINGS), {
            _tag: "already-decided",
            outcome: "declined",
          });
          assert.deepEqual((yield* settings.getSettings).workjet.workerProfiles, []);
        }).pipe(Effect.provide(makeImportLayer(disk))),
      );
    });
  });

  it("re-offers when the marker itself is corrupt, because re-importing is safe", () => {
    const disk = makeDisk({ [LEGACY_PATH]: goldenText, [MARKER_PATH]: "{ truncated" });

    return Effect.gen(function* () {
      const importer = yield* LegacyWorkjetImport;
      assert.deepEqual(importer.decision, { _tag: "import-offer", legacyPath: LEGACY_PATH });
    }).pipe(Effect.provide(makeImportLayer(disk)), Effect.scoped);
  });
});

describe("readAndMapLegacyWorkjetConfig", () => {
  it("is the single path the preview and the import share", () => {
    const read = readAndMapLegacyWorkjetConfig({
      text: goldenText,
      bindings: EMPTY_LEGACY_WORKJET_BINDINGS,
    });
    assert.strictEqual(read._tag, "mapped");
    if (read._tag !== "mapped") return;
    assert.strictEqual(read.legacyVersion, 1);
    assert.strictEqual(read.result.counts.workersTotal, 4);
  });

  it("fails closed on text that is not the legacy document", () => {
    const read = readAndMapLegacyWorkjetConfig({
      text: "not json",
      bindings: EMPTY_LEGACY_WORKJET_BINDINGS,
    });
    assert.strictEqual(read._tag, "unreadable");
  });
});
