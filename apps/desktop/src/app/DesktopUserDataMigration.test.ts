import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopUserDataMigration from "./DesktopUserDataMigration.ts";

const {
  DesktopUserDataMigration: DesktopUserDataMigrationService,
  USER_DATA_MIGRATION_ALLOWLIST,
  USER_DATA_MIGRATION_DENIED_ENTRY_NAMES,
  USER_DATA_MIGRATION_MARKER_FILE,
  copyAllowlistedUserData,
  decideUserDataMigration,
  isCopyableUserDataEntry,
} = DesktopUserDataMigration;

const joinPath = (first: string, ...rest: string[]): string => [first, ...rest].join("/");

const marker = (
  overrides: Partial<DesktopUserDataMigration.UserDataMigrationMarker> = {},
): DesktopUserDataMigration.UserDataMigrationMarker => ({
  version: 1,
  outcome: "migrated",
  legacyPath: null,
  decidedAt: "2026-01-01T00:00:00.000Z",
  copiedEntries: [],
  ...overrides,
});

describe("decideUserDataMigration", () => {
  it("reports a fresh install when no legacy directory exists", () => {
    assert.deepEqual(
      decideUserDataMigration({
        marker: Option.none(),
        legacyCandidates: [
          { path: "/support/t3code", exists: false },
          { path: "/support/T3 Code (Alpha)", exists: false },
        ],
      }),
      { _tag: "fresh" },
    );
  });

  it("offers the migration for the first existing legacy candidate, in order", () => {
    assert.deepEqual(
      decideUserDataMigration({
        marker: Option.none(),
        legacyCandidates: [
          { path: "/support/t3code", exists: true },
          { path: "/support/T3 Code (Alpha)", exists: true },
        ],
      }),
      { _tag: "migrate-offer", legacyPath: "/support/t3code" },
    );

    assert.deepEqual(
      decideUserDataMigration({
        marker: Option.none(),
        legacyCandidates: [
          { path: "/support/t3code", exists: false },
          { path: "/support/T3 Code (Alpha)", exists: true },
        ],
      }),
      { _tag: "migrate-offer", legacyPath: "/support/T3 Code (Alpha)" },
    );
  });

  it.each(["migrated", "declined"] as const)(
    "never re-offers once the marker records %s",
    (outcome) => {
      assert.deepEqual(
        decideUserDataMigration({
          marker: Option.some(marker({ outcome })),
          legacyCandidates: [{ path: "/support/t3code", exists: true }],
        }),
        { _tag: "already-migrated", outcome },
      );
    },
  );

  it("runs the copy once for an accepted offer", () => {
    assert.deepEqual(
      decideUserDataMigration({
        marker: Option.some(marker({ outcome: "accepted-pending", legacyPath: "/support/t3code" })),
        legacyCandidates: [{ path: "/support/t3code", exists: true }],
      }),
      { _tag: "copy-pending", legacyPath: "/support/t3code" },
    );
  });

  it("degrades an accepted offer whose source disappeared", () => {
    assert.deepEqual(
      decideUserDataMigration({
        marker: Option.some(marker({ outcome: "accepted-pending", legacyPath: "/support/t3code" })),
        legacyCandidates: [{ path: "/support/t3code", exists: false }],
      }),
      { _tag: "already-migrated", outcome: "migrated" },
    );
  });
});

describe("user-data allowlist", () => {
  it("carries the sign-in state and no cache directories", () => {
    for (const required of ["Preferences", "Local State", "Cookies", "Partitions"]) {
      assert.include([...USER_DATA_MIGRATION_ALLOWLIST], required);
    }
    for (const entry of USER_DATA_MIGRATION_ALLOWLIST) {
      assert.isTrue(isCopyableUserDataEntry(entry), `${entry} must be copyable`);
    }
    for (const denied of USER_DATA_MIGRATION_DENIED_ENTRY_NAMES) {
      assert.isFalse(isCopyableUserDataEntry(denied), `${denied} must be skipped`);
    }
  });
});

interface FakeTree {
  readonly directories: ReadonlySet<string>;
  readonly files: ReadonlySet<string>;
}

const makeFakeFileSystemLayer = (tree: FakeTree, recorded: { copied: string[]; made: string[] }) =>
  FileSystem.layerNoop({
    exists: (path) => Effect.succeed(tree.directories.has(path) || tree.files.has(path)),
    stat: (path) =>
      tree.directories.has(path)
        ? Effect.succeed({ type: "Directory" } as FileSystem.File.Info)
        : tree.files.has(path)
          ? Effect.succeed({ type: "File" } as FileSystem.File.Info)
          : Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "stat",
                description: "missing",
                pathOrDescriptor: path,
              }),
            ),
    readDirectory: (path) =>
      Effect.succeed(
        [...tree.directories, ...tree.files]
          .filter((entry) => entry.startsWith(`${path}/`))
          .map((entry) => entry.slice(path.length + 1))
          .filter((entry) => !entry.includes("/")),
      ),
    makeDirectory: (path) =>
      Effect.sync(() => {
        recorded.made.push(path);
      }),
    copyFile: (from, to) =>
      Effect.sync(() => {
        recorded.copied.push(`${from} -> ${to}`);
      }),
  });

describe("copyAllowlistedUserData", () => {
  const legacyPath = "/support/t3code";
  const targetPath = "/support/CTOX Desktop App";

  const tree: FakeTree = {
    directories: new Set([
      legacyPath,
      `${legacyPath}/Partitions`,
      `${legacyPath}/Partitions/workjet-ctox-control-plane`,
      `${legacyPath}/Partitions/workjet-ctox-control-plane/Cache`,
      `${legacyPath}/Local Storage`,
      `${legacyPath}/Cache`,
      `${legacyPath}/Code Cache`,
    ]),
    files: new Set([
      `${legacyPath}/Preferences`,
      `${legacyPath}/Local State`,
      `${legacyPath}/Cookies`,
      `${legacyPath}/DevToolsActivePort`,
      `${legacyPath}/Partitions/workjet-ctox-control-plane/Cookies`,
      `${legacyPath}/Partitions/workjet-ctox-control-plane/Cache/data_0`,
      `${legacyPath}/Local Storage/leveldb`,
      `${legacyPath}/Cache/data_0`,
    ]),
  };

  it.effect("copies allowlisted entries, skips caches, and never touches the source", () => {
    const recorded = { copied: [] as string[], made: [] as string[] };

    return Effect.gen(function* () {
      const copied = yield* copyAllowlistedUserData({ legacyPath, targetPath, joinPath });

      assert.deepEqual(
        [...copied],
        ["Preferences", "Local State", "Cookies", "Local Storage", "Partitions"],
      );
      assert.deepEqual(recorded.copied, [
        `${legacyPath}/Preferences -> ${targetPath}/Preferences`,
        `${legacyPath}/Local State -> ${targetPath}/Local State`,
        `${legacyPath}/Cookies -> ${targetPath}/Cookies`,
        `${legacyPath}/Local Storage/leveldb -> ${targetPath}/Local Storage/leveldb`,
        `${legacyPath}/Partitions/workjet-ctox-control-plane/Cookies -> ${targetPath}/Partitions/workjet-ctox-control-plane/Cookies`,
      ]);
      // Not an allowlisted entry, and the profile-level caches stay behind.
      assert.notInclude(recorded.copied.join("\n"), "DevToolsActivePort");
      assert.notInclude(recorded.copied.join("\n"), "Cache");
      // A COPY: nothing removes or rewrites anything under the legacy path.
      for (const line of recorded.made) {
        assert.isFalse(line.startsWith(legacyPath), `${line} must not be created in the source`);
      }
    }).pipe(Effect.provide(makeFakeFileSystemLayer(tree, recorded)));
  });
});

interface FakeDisk {
  readonly existing: ReadonlySet<string>;
  readonly files: Map<string, string>;
}

const makeMigrationLayer = (disk: FakeDisk, recorded: { copied: string[] }) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    appDataDirectory: "/support",
    userDataDirName: "CTOX Desktop App",
    legacyUserDataDirNames: ["t3code", "T3 Code (Alpha)"],
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const fileSystem = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(disk.existing.has(path) || disk.files.has(path)),
    stat: (path) =>
      disk.existing.has(path)
        ? Effect.succeed({ type: "Directory" } as FileSystem.File.Info)
        : Effect.succeed({ type: "File" } as FileSystem.File.Info),
    readDirectory: () => Effect.succeed([]),
    makeDirectory: () => Effect.void,
    copyFile: (from, to) =>
      Effect.sync(() => {
        recorded.copied.push(`${from} -> ${to}`);
      }),
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
        disk.files.set(path, data);
      }),
  });

  return DesktopUserDataMigration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment), fileSystem),
    ),
  );
};

const markerPath = `/support/CTOX Desktop App/${USER_DATA_MIGRATION_MARKER_FILE}`;

describe("DesktopUserDataMigration marker idempotency", () => {
  it.effect("offers once, then records the decision and never offers again", () => {
    const disk: FakeDisk = { existing: new Set(["/support/t3code"]), files: new Map() };
    const recorded = { copied: [] as string[] };

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const migration = yield* DesktopUserDataMigrationService;
          assert.deepEqual(migration.decision, {
            _tag: "migrate-offer",
            legacyPath: "/support/t3code",
          });
          assert.isTrue(Option.isSome(migration.offer));
          yield* migration.decline;
        }).pipe(Effect.provide(makeMigrationLayer(disk, recorded))),
      );

      const written = disk.files.get(markerPath);
      assert.isDefined(written);
      assert.include(written, '"outcome":"declined"');

      // Second launch: the marker is terminal, so nothing is offered or copied.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const migration = yield* DesktopUserDataMigrationService;
          assert.deepEqual(migration.decision, {
            _tag: "already-migrated",
            outcome: "declined",
          });
          assert.isTrue(Option.isNone(migration.offer));
        }).pipe(Effect.provide(makeMigrationLayer(disk, recorded))),
      );

      assert.deepEqual(recorded.copied, []);
    });
  });

  it.effect("runs an accepted copy exactly once across launches", () => {
    const disk: FakeDisk = {
      existing: new Set(["/support/t3code"]),
      files: new Map([
        ["/support/t3code/Preferences", "{}"],
        ["/support/t3code/Cookies", "cookie-jar"],
      ]),
    };
    const recorded = { copied: [] as string[] };

    return Effect.gen(function* () {
      // Launch 1: user accepts.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const migration = yield* DesktopUserDataMigrationService;
          yield* migration.accept;
        }).pipe(Effect.provide(makeMigrationLayer(disk, recorded))),
      );
      assert.include(disk.files.get(markerPath), '"outcome":"accepted-pending"');
      assert.deepEqual(recorded.copied, [], "the copy must not run in the accepting launch");

      // Launch 2: the copy runs and the marker becomes terminal.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const migration = yield* DesktopUserDataMigrationService;
          assert.deepEqual(migration.decision, {
            _tag: "already-migrated",
            outcome: "migrated",
          });
        }).pipe(Effect.provide(makeMigrationLayer(disk, recorded))),
      );
      const copiedAfterImport = recorded.copied.length;
      assert.isAbove(copiedAfterImport, 0);
      assert.include(disk.files.get(markerPath), '"outcome":"migrated"');

      // Launch 3: nothing runs again.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const migration = yield* DesktopUserDataMigrationService;
          assert.isTrue(Option.isNone(migration.offer));
        }).pipe(Effect.provide(makeMigrationLayer(disk, recorded))),
      );
      assert.equal(recorded.copied.length, copiedAfterImport);
    });
  });

  it.effect("stays fresh and writes nothing when there is no legacy directory", () => {
    const disk: FakeDisk = { existing: new Set(), files: new Map() };
    const recorded = { copied: [] as string[] };

    return Effect.scoped(
      Effect.gen(function* () {
        const migration = yield* DesktopUserDataMigrationService;
        assert.deepEqual(migration.decision, { _tag: "fresh" });
        assert.isTrue(Option.isNone(migration.offer));
        assert.equal(disk.files.size, 0);
      }).pipe(Effect.provide(makeMigrationLayer(disk, recorded))),
    );
  });
});
