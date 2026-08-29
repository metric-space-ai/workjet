// @effect-diagnostics nodeBuiltinImport:off - the construction path must stay free of macrotask yields (pre-ready ordering), so it uses Node's synchronous fs; see syncFileSystemLayer.
import * as NodeFS from "node:fs";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-user-data-migration");

/**
 * Recorded inside the *new* user-data directory. Its presence is the single
 * "this was already decided" signal, so the offer is shown at most once —
 * including when the user declined.
 */
export const USER_DATA_MIGRATION_MARKER_FILE = "workjet-user-data-migration.json";

/**
 * Top-level entries copied out of the previous Workjet Electron profile.
 *
 * The directory is a Chromium profile: the app's own settings live in
 * ~/.t3/<userdata|dev> (DesktopEnvironment.stateDir) and are NOT affected by
 * this migration. What is worth carrying over is the durable browsing state
 * that represents "I am signed in":
 *
 *  - Preferences / Local State — profile preferences. `Local State` also holds
 *    the OS-wrapped os_crypt key on Windows and Linux; without it the copied
 *    cookie jar cannot be decrypted there, so it is not optional.
 *  - Cookies (+ journal) — default-session logins.
 *  - Local Storage / Session Storage / IndexedDB / WebStorage — renderer state.
 *  - Partitions — the per-CTOX-instance sessions (`workjet-ctox-*`) and the
 *    preview browser session. These carry the sign-in for every connected CTOX
 *    instance; dropping them would silently log the user out of all of them,
 *    which is exactly the pain this migration exists to avoid. Cache-shaped
 *    children inside them are filtered out by the deny list below.
 *
 * Everything not named here is deliberately left behind.
 *
 * OS keychain: safeStorage's encryption key is keyed by the *application name*
 * (Electron asks the OS for "<app.getName()> Safe Storage"), not by the
 * user-data directory. Changing the directory therefore orphans nothing —
 * every safeStorage-encrypted value stays decryptable, and the copied cookie
 * jar keeps working. The app's own encrypted secrets (connection catalog,
 * saved environments) live under ~/.t3 and are untouched by this migration
 * altogether. If the display name in DesktopEnvironment ever changes, THAT is
 * what orphans keychain secrets, and it needs its own migration.
 */
export const USER_DATA_MIGRATION_ALLOWLIST: readonly string[] = [
  "Preferences",
  "Local State",
  "Cookies",
  "Cookies-journal",
  "Network Persistent State",
  "Trust Tokens",
  "Trust Tokens-journal",
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "WebStorage",
  "Partitions",
];

/**
 * Names skipped at every depth of an allowlisted directory. All of these are
 * regenerable caches — copying them wastes hundreds of megabytes and can carry
 * a stale compiled-code cache into a different Electron build.
 */
export const USER_DATA_MIGRATION_DENIED_ENTRY_NAMES: readonly string[] = [
  "Cache",
  "Cache_Data",
  "CacheStorage",
  "Code Cache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUCache",
  "ScriptCache",
  "Service Worker",
  "Shared Dictionary",
  "blob_storage",
  "component_crx_cache",
];

const deniedEntryNames = new Set(USER_DATA_MIGRATION_DENIED_ENTRY_NAMES);

export function isCopyableUserDataEntry(entryName: string): boolean {
  return !deniedEntryNames.has(entryName);
}

export const UserDataMigrationOutcome = Schema.Literals([
  // The copy ran and finished.
  "migrated",
  // The user said no. Terminal: the offer is never shown again.
  "declined",
  // The user said yes; the copy runs on the next launch, before Chromium
  // opens the profile. Copying into a live profile can corrupt its SQLite
  // files, so acceptance and copying are deliberately separate launches.
  "accepted-pending",
]);
export type UserDataMigrationOutcome = typeof UserDataMigrationOutcome.Type;

export const UserDataMigrationMarker = Schema.Struct({
  version: Schema.Literal(1),
  outcome: UserDataMigrationOutcome,
  legacyPath: Schema.NullOr(Schema.String),
  decidedAt: Schema.String,
  copiedEntries: Schema.Array(Schema.String),
});
export type UserDataMigrationMarker = typeof UserDataMigrationMarker.Type;

const decodeMarker = Schema.decodeEffect(Schema.fromJsonString(UserDataMigrationMarker));
const encodeMarker = Schema.encodeEffect(Schema.fromJsonString(UserDataMigrationMarker));

export type UserDataMigrationDecision =
  /** Nothing to import: no legacy directory exists. */
  | { readonly _tag: "fresh" }
  /** A legacy directory exists and the user has not been asked yet. */
  | { readonly _tag: "migrate-offer"; readonly legacyPath: string }
  /** The user accepted last launch; the copy must run now. */
  | { readonly _tag: "copy-pending"; readonly legacyPath: string }
  /** A marker already records a terminal decision. */
  | {
      readonly _tag: "already-migrated";
      readonly outcome: Exclude<UserDataMigrationOutcome, "accepted-pending">;
    };

export interface LegacyUserDataCandidate {
  readonly path: string;
  readonly exists: boolean;
}

/**
 * Pure decision. Every filesystem fact it needs is passed in, so the whole
 * matrix is testable without touching a real user-data directory.
 *
 * Ordering matters: a recorded marker always wins, so no path through this
 * function can run the copy twice.
 */
export function decideUserDataMigration(input: {
  readonly marker: Option.Option<UserDataMigrationMarker>;
  readonly legacyCandidates: readonly LegacyUserDataCandidate[];
}): UserDataMigrationDecision {
  const legacyPath = input.legacyCandidates.find((candidate) => candidate.exists)?.path;

  if (Option.isSome(input.marker)) {
    const marker = input.marker.value;
    if (marker.outcome !== "accepted-pending") {
      return { _tag: "already-migrated", outcome: marker.outcome };
    }
    // An accepted offer whose source vanished between launches degrades to
    // "nothing to do" rather than stalling on every boot.
    const pendingPath = marker.legacyPath ?? legacyPath;
    if (pendingPath === undefined || pendingPath !== legacyPath) {
      return { _tag: "already-migrated", outcome: "migrated" };
    }
    return { _tag: "copy-pending", legacyPath: pendingPath };
  }

  return legacyPath === undefined ? { _tag: "fresh" } : { _tag: "migrate-offer", legacyPath };
}

export interface UserDataMigrationOffer {
  readonly legacyPath: string;
  readonly targetPath: string;
}

export class DesktopUserDataMigration extends Context.Service<
  DesktopUserDataMigration,
  {
    /** Decision resolved once, while this service is constructed. */
    readonly decision: UserDataMigrationDecision;
    /** Present only when a one-time prompt should be shown. */
    readonly offer: Option.Option<UserDataMigrationOffer>;
    /**
     * Record acceptance. The copy itself happens on the next launch, so the
     * caller must restart the app for the import to take effect.
     */
    readonly accept: Effect.Effect<void>;
    /** Record refusal. Terminal — the offer is never shown again. */
    readonly decline: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopUserDataMigration") {}

export type JoinPath = (first: string, ...rest: string[]) => string;

const copyEntry = (
  from: string,
  to: string,
  joinPath: JoinPath,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* fileSystem.stat(from);

    if (info.type === "Directory") {
      yield* fileSystem.makeDirectory(to, { recursive: true });
      const children = yield* fileSystem.readDirectory(from);
      for (const child of children) {
        if (!isCopyableUserDataEntry(child)) continue;
        yield* copyEntry(joinPath(from, child), joinPath(to, child), joinPath);
      }
      return;
    }

    // Sockets, symlinks, and lock files are never carried over.
    if (info.type !== "File") return;
    yield* fileSystem.copyFile(from, to);
  });

/**
 * Copy the allowlisted entries from `legacyPath` into `targetPath` and return
 * the names actually copied.
 *
 * This is an offline COPY before Chromium opens the target profile. The source
 * directory is never modified or used as a live fallback. This is the sole
 * transition from the previous Workjet Electron storage identity.
 */
export const copyAllowlistedUserData = Effect.fn("desktop.userDataMigration.copy")(
  function* (input: {
    readonly legacyPath: string;
    readonly targetPath: string;
    readonly joinPath: JoinPath;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const copied: string[] = [];

    yield* fileSystem.makeDirectory(input.targetPath, { recursive: true });

    for (const name of USER_DATA_MIGRATION_ALLOWLIST) {
      if (!isCopyableUserDataEntry(name)) continue;
      const from = input.joinPath(input.legacyPath, name);
      const exists = yield* fileSystem.exists(from);
      if (!exists) continue;
      yield* copyEntry(from, input.joinPath(input.targetPath, name), input.joinPath);
      copied.push(name);
    }

    return copied as readonly string[];
  },
);

/**
 * A SYNCHRONOUS FileSystem for this service's construction path.
 *
 * The service is constructed before Electron's `ready` event. The async Node FileSystem yields to the
 * macrotask queue on every operation, which lets `ready` fire mid-graph and
 * could let readiness-sensitive platform setup run mid-graph. Wrapping Node's sync fs in `Effect.sync` keeps the
 * whole construction free of macrotask boundaries, so `ready` cannot preempt
 * it. The one-time blocking copy is acceptable: it runs exactly once, on the
 * launch after the user accepted the import.
 */
export const syncFileSystemLayer = FileSystem.layerNoop({
  exists: (path) => Effect.sync(() => NodeFS.existsSync(path)),
  stat: (path) =>
    Effect.try({
      try: () => {
        const info = NodeFS.lstatSync(path);
        const type = info.isDirectory() ? "Directory" : info.isFile() ? "File" : "Unknown";
        return { type } as FileSystem.File.Info;
      },
      catch: () =>
        PlatformError.systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "stat",
          description: "stat failed",
          pathOrDescriptor: path,
        }),
    }),
  readDirectory: (path) =>
    Effect.try({
      try: () => NodeFS.readdirSync(path),
      catch: () =>
        PlatformError.systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readDirectory",
          description: "readdir failed",
          pathOrDescriptor: path,
        }),
    }),
  makeDirectory: (path) =>
    Effect.try({
      try: () => {
        NodeFS.mkdirSync(path, { recursive: true });
      },
      catch: () =>
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "makeDirectory",
          description: "mkdir failed",
          pathOrDescriptor: path,
        }),
    }),
  copyFile: (from, to) =>
    Effect.try({
      try: () => {
        NodeFS.copyFileSync(from, to);
      },
      catch: () =>
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "copyFile",
          description: "copy failed",
          pathOrDescriptor: from,
        }),
    }),
  readFileString: (path) =>
    Effect.try({
      try: () => NodeFS.readFileSync(path, "utf8"),
      catch: () =>
        PlatformError.systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
          description: "read failed",
          pathOrDescriptor: path,
        }),
    }),
  writeFileString: (path, content) =>
    Effect.try({
      try: () => {
        NodeFS.writeFileSync(path, content, "utf8");
      },
      catch: () =>
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "writeFileString",
          description: "write failed",
          pathOrDescriptor: path,
        }),
    }),
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;

  const targetPath = environment.path.join(
    environment.appDataDirectory,
    environment.userDataDirName,
  );
  const markerPath = environment.path.join(targetPath, USER_DATA_MIGRATION_MARKER_FILE);

  const readMarker = fileSystem.readFileString(markerPath).pipe(
    Effect.flatMap(decodeMarker),
    // A missing marker means "not decided yet"; an unreadable or corrupt one
    // is treated the same way, which is safe because the copy never deletes
    // anything and skips entries that already exist at the destination.
    Effect.option,
  );

  const writeMarker = (marker: UserDataMigrationMarker) =>
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(targetPath, { recursive: true });
      yield* fileSystem.writeFileString(markerPath, yield* encodeMarker(marker));
    }).pipe(
      Effect.catchCause((cause) =>
        logWarning("failed to record the user-data migration marker", {
          markerPath,
          outcome: marker.outcome,
          cause: String(cause),
        }),
      ),
    );

  const legacyCandidates: readonly LegacyUserDataCandidate[] = yield* Effect.forEach(
    environment.legacyUserDataDirNames,
    (name) => {
      const path = environment.path.join(environment.appDataDirectory, name);
      return fileSystem.exists(path).pipe(
        Effect.orElseSucceed(() => false),
        Effect.map((exists) => ({ path, exists })),
      );
    },
  );

  const markerBeforeDecision = yield* readMarker;
  let decision = decideUserDataMigration({
    marker: markerBeforeDecision,
    legacyCandidates,
  });

  if (decision._tag === "copy-pending") {
    const legacyPath = decision.legacyPath;
    const copied = yield* copyAllowlistedUserData({
      legacyPath,
      targetPath,
      joinPath: environment.path.join,
    }).pipe(
      Effect.tapCause((cause) =>
        logWarning("previous Workjet user-data import failed", {
          legacyPath,
          cause: String(cause),
        }),
      ),
      Effect.orElseSucceed(() => [] as readonly string[]),
    );
    yield* writeMarker({
      version: 1,
      outcome: "migrated",
      legacyPath,
      decidedAt: DateTime.formatIso(yield* DateTime.now),
      copiedEntries: copied,
    });
    yield* logInfo("imported previous Workjet user data", {
      legacyPath,
      targetPath,
      copiedEntries: [...copied],
    });
    decision = { _tag: "already-migrated", outcome: "migrated" };
  }

  const offer: Option.Option<UserDataMigrationOffer> =
    decision._tag === "migrate-offer"
      ? Option.some({ legacyPath: decision.legacyPath, targetPath })
      : Option.none();

  const recordDecision = (outcome: UserDataMigrationOutcome) =>
    Effect.gen(function* () {
      yield* writeMarker({
        version: 1,
        outcome,
        legacyPath: Option.match(offer, {
          onNone: () => null,
          onSome: (value) => value.legacyPath,
        }),
        decidedAt: DateTime.formatIso(yield* DateTime.now),
        copiedEntries: [],
      });
    });

  return DesktopUserDataMigration.of({
    decision,
    offer,
    accept: recordDecision("accepted-pending"),
    decline: recordDecision("declined"),
  });
}).pipe(Effect.withSpan("desktop.userDataMigration.make"));

export const layer = Layer.effect(DesktopUserDataMigration, make);
