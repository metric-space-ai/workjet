// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { CtoxInstanceApp } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const RAIL_VERSION = 2;
const LEGACY_RAIL_VERSION = 1;
/**
 * Identity of a v1 record that has not been claimed by a stable identity yet.
 * A v1 document was keyed on the renderer registry id, which changes whenever
 * the same CTOX instance is paired again.
 */
const LEGACY_KEY_PREFIX = "legacy:";
const RAIL_FILE = "app-rail.json";
export const MAX_RAIL_APPS = 128;
export const MAX_DOCKED_APPS = 64;
const MAX_RAIL_INSTANCES = 1_000;

export const CTOX_APP_MODULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const RailModuleId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
  Schema.isPattern(CTOX_APP_MODULE_ID_PATTERN),
);
const RailAppTitle = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
);
const RailAppCategory = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
);
/**
 * `category` is additive on the v2 document: it decodes as an optional key, so
 * records written before it existed stay valid and no version bump is needed.
 */
const RailCachedApp = Schema.Struct({
  id: RailModuleId,
  title: Schema.optionalKey(RailAppTitle),
  category: Schema.optionalKey(RailAppCategory),
  lastSeenAt: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
type RailCachedApp = typeof RailCachedApp.Type;
const RailInstanceKeyText = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
);
const RailInstanceRecord = Schema.Struct({
  identity: RailInstanceKeyText,
  workspaceName: Schema.optionalKey(RailAppTitle),
  docked: Schema.Array(RailModuleId).check(Schema.isMaxLength(MAX_DOCKED_APPS)),
  apps: Schema.Array(RailCachedApp).check(Schema.isMaxLength(MAX_RAIL_APPS)),
});
type RailInstanceRecord = typeof RailInstanceRecord.Type;
const RailDocument = Schema.Struct({
  version: Schema.Literal(RAIL_VERSION),
  instances: Schema.Array(RailInstanceRecord).check(Schema.isMaxLength(MAX_RAIL_INSTANCES)),
});
type RailDocument = typeof RailDocument.Type;
const LegacyRailDocument = Schema.Struct({
  version: Schema.Literal(LEGACY_RAIL_VERSION),
  instances: Schema.Array(
    Schema.Struct({
      instanceId: RailInstanceKeyText,
      workspaceName: Schema.optionalKey(RailAppTitle),
      docked: Schema.Array(RailModuleId).check(Schema.isMaxLength(MAX_DOCKED_APPS)),
      apps: Schema.Array(RailCachedApp).check(Schema.isMaxLength(MAX_RAIL_APPS)),
    }),
  ).check(Schema.isMaxLength(MAX_RAIL_INSTANCES)),
});
type LegacyRailDocument = typeof LegacyRailDocument.Type;
const RailDocumentJson = Schema.fromJsonString(RailDocument);
const StoredRailDocumentJson = Schema.fromJsonString(
  Schema.Union([RailDocument, LegacyRailDocument]),
);

/** Carry a v1 record forward under its legacy key so it can still be claimed. */
function migrateStoredDocument(document: RailDocument | LegacyRailDocument): RailDocument {
  if (document.version === RAIL_VERSION) return document;
  return {
    version: RAIL_VERSION,
    instances: document.instances.map(({ instanceId, ...record }) => ({
      ...record,
      identity: `${LEGACY_KEY_PREFIX}${instanceId}`,
    })),
  };
}

const EMPTY_DOCUMENT: RailDocument = { version: RAIL_VERSION, instances: [] };

export class CtoxAppRailError extends Schema.TaggedErrorClass<CtoxAppRailError>()(
  "CtoxAppRailError",
  { code: Schema.Literals(["persistence_failed"]) },
) {}

const railError = (code: "persistence_failed") => new CtoxAppRailError({ code });

/** An app observed live on the guest: installed module plus open marker. */
export interface CtoxLiveGuestApp {
  readonly id: string;
  readonly title?: string;
  /** The guest module's own launcher category, used to sub-group the rail. */
  readonly category?: string;
}

/**
 * Rail records are keyed on the stable identity of the CTOX instance, which the
 * main process resolves from the renderer registry id. The registry id changes
 * when the same instance is paired again; the identity does not, so docked pins
 * and the cached app list survive a remove and re-pair.
 */
export interface CtoxRailInstanceKey {
  readonly identity: string;
  /** Renderer registry id, used only to claim a not-yet-migrated v1 record. */
  readonly legacyInstanceId?: string;
}

export interface CtoxRailInstanceState {
  readonly docked: readonly string[];
  readonly apps: readonly RailCachedApp[];
  readonly workspaceName?: string;
}

/**
 * Session-list merge (T3 analogy): every installed app of the instance is
 * listed like sessions under a project. Docked apps come first in pin order,
 * then the remaining installed apps; open apps carry the open marker. While
 * the guest is away the last cached app list renders instead.
 */
export function mergeRailApps(input: {
  readonly docked: readonly string[];
  readonly cached: readonly RailCachedApp[];
  readonly live?: {
    readonly apps: readonly CtoxLiveGuestApp[];
    readonly activeModuleId: string | null;
    readonly openModuleIds?: readonly string[];
  };
  readonly nowEpochMs: number;
}): readonly CtoxInstanceApp[] {
  const cachedById = new Map(input.cached.map((app) => [app.id, app]));
  const liveById = new Map((input.live?.apps ?? []).map((app) => [app.id, app]));
  const activeId = input.live?.activeModuleId ?? null;
  const openIds = new Set(input.live?.openModuleIds ?? []);
  if (activeId !== null) openIds.add(activeId);
  const rows: CtoxInstanceApp[] = [];
  const seen = new Set<string>();
  const pushRow = (id: string, docked: boolean) => {
    if (!CTOX_APP_MODULE_ID_PATTERN.test(id) || seen.has(id)) return;
    seen.add(id);
    const live = liveById.get(id);
    const cached = cachedById.get(id);
    const title = live?.title ?? cached?.title;
    // A cached category survives a guest that no longer reports one, so the
    // rail keeps its grouping while the instance is disconnected.
    const category = live?.category ?? cached?.category;
    const lastSeenAt = input.live !== undefined ? input.nowEpochMs : cached?.lastSeenAt;
    rows.push({
      id,
      ...(title === undefined ? {} : { title }),
      ...(category === undefined ? {} : { category }),
      docked,
      open: openIds.has(id),
      ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    });
  };
  const dockedSet = new Set(input.docked);
  for (const id of input.docked) pushRow(id, true);
  // Open apps that are not installed-listed (transient windows) still show.
  for (const id of openIds) pushRow(id, dockedSet.has(id));
  const remaining =
    input.live !== undefined
      ? input.live.apps.map((app) => app.id)
      : input.cached.map((app) => app.id);
  for (const id of remaining) pushRow(id, dockedSet.has(id));
  return rows;
}

/** Fold a live guest observation into the cached app list. */
export function refreshRailCache(input: {
  readonly cached: readonly RailCachedApp[];
  readonly live: readonly CtoxLiveGuestApp[];
  readonly nowEpochMs: number;
}): readonly RailCachedApp[] {
  const next = new Map(input.cached.map((app) => [app.id, app]));
  for (const app of input.live) {
    if (!CTOX_APP_MODULE_ID_PATTERN.test(app.id)) continue;
    const previous = next.get(app.id);
    const title = app.title ?? previous?.title;
    const category = app.category ?? previous?.category;
    next.set(app.id, {
      id: app.id,
      ...(title === undefined ? {} : { title }),
      ...(category === undefined ? {} : { category }),
      lastSeenAt: input.nowEpochMs,
    });
  }
  return [...next.values()]
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
    .slice(0, MAX_RAIL_APPS);
}

export class CtoxAppRail extends Context.Service<
  CtoxAppRail,
  {
    readonly stateForInstance: (
      key: CtoxRailInstanceKey,
    ) => Effect.Effect<CtoxRailInstanceState, CtoxAppRailError>;
    readonly setDocked: (
      key: CtoxRailInstanceKey,
      moduleId: string,
      docked: boolean,
    ) => Effect.Effect<void, CtoxAppRailError>;
    readonly recordLiveApps: (
      key: CtoxRailInstanceKey,
      live: readonly CtoxLiveGuestApp[],
      nowEpochMs: number,
      workspaceName?: string,
    ) => Effect.Effect<void, CtoxAppRailError>;
    readonly removeInstance: (key: CtoxRailInstanceKey) => Effect.Effect<void, CtoxAppRailError>;
  }
>()("@t3tools/desktop/ctox/CtoxAppRail") {}

export const make = Effect.fn("CtoxAppRail.make")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const railPath = path.join(environment.stateDir, "ctox", RAIL_FILE);

  const readDocument = Effect.fn("CtoxAppRail.readDocument")(function* () {
    const exists = yield* fileSystem.exists(railPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return EMPTY_DOCUMENT;
    const contents = yield* fileSystem
      .readFileString(railPath)
      .pipe(Effect.mapError(() => railError("persistence_failed")));
    // A corrupt rail store must never break the sidebar: fall back to empty.
    return yield* Schema.decodeEffect(StoredRailDocumentJson)(contents.trim()).pipe(
      Effect.map(migrateStoredDocument),
      Effect.orElseSucceed(() => EMPTY_DOCUMENT),
    );
  });

  const writeDocument = Effect.fn("CtoxAppRail.writeDocument")(function* (document: RailDocument) {
    const contents = yield* Schema.encodeEffect(RailDocumentJson)(document).pipe(
      Effect.mapError(() => railError("persistence_failed")),
    );
    const suffix = yield* crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => uuid.replaceAll("-", "")),
      Effect.mapError(() => railError("persistence_failed")),
    );
    const temporaryPath = `${railPath}.${process.pid}.${suffix}.tmp`;
    yield* fileSystem
      .makeDirectory(path.dirname(railPath), { recursive: true })
      .pipe(Effect.mapError(() => railError("persistence_failed")));
    yield* fileSystem
      .writeFileString(temporaryPath, `${contents}\n`)
      .pipe(Effect.mapError(() => railError("persistence_failed")));
    yield* fileSystem
      .rename(temporaryPath, railPath)
      .pipe(Effect.mapError(() => railError("persistence_failed")));
  });

  /** The stable identity first, then the v1 record the registry id left behind. */
  const findRecord = (document: RailDocument, key: CtoxRailInstanceKey) =>
    document.instances.find((record) => record.identity === key.identity) ??
    (key.legacyInstanceId === undefined
      ? undefined
      : document.instances.find(
          (record) => record.identity === `${LEGACY_KEY_PREFIX}${key.legacyInstanceId}`,
        ));

  const modifyRecord = (
    key: CtoxRailInstanceKey,
    update: (record: RailInstanceRecord) => RailInstanceRecord | undefined,
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        const document = yield* readDocument();
        const existing = findRecord(document, key);
        const updated = update(existing ?? { identity: key.identity, docked: [], apps: [] });
        const others = document.instances.filter(
          (record) => record !== existing && record.identity !== key.identity,
        );
        const instances =
          updated === undefined
            ? others
            : [...others, { ...updated, identity: key.identity }].slice(0, MAX_RAIL_INSTANCES);
        yield* writeDocument({ version: RAIL_VERSION, instances });
      }),
    );

  return CtoxAppRail.of({
    stateForInstance: (key) =>
      lock.withPermit(
        Effect.gen(function* () {
          const document = yield* readDocument();
          const record = findRecord(document, key);
          if (record !== undefined && record.identity !== key.identity) {
            // Claim the v1 record now, while the registry id it was written
            // under is still the current one. A failed rewrite is not fatal:
            // the state below is served either way.
            yield* writeDocument({
              version: RAIL_VERSION,
              instances: document.instances.map((entry) =>
                entry === record ? { ...entry, identity: key.identity } : entry,
              ),
            }).pipe(Effect.orElseSucceed(() => undefined));
          }
          return {
            docked: record?.docked ?? [],
            apps: record?.apps ?? [],
            ...(record?.workspaceName === undefined ? {} : { workspaceName: record.workspaceName }),
          };
        }),
      ),
    setDocked: (key, moduleId, docked) =>
      modifyRecord(key, (record) => {
        const withoutModule = record.docked.filter((id) => id !== moduleId);
        const nextDocked = docked
          ? [...withoutModule, moduleId].slice(-MAX_DOCKED_APPS)
          : withoutModule;
        return { ...record, docked: nextDocked };
      }),
    recordLiveApps: (key, live, nowEpochMs, workspaceName) =>
      modifyRecord(key, (record) => ({
        ...record,
        ...(workspaceName === undefined || workspaceName.length === 0 ? {} : { workspaceName }),
        apps: refreshRailCache({ cached: record.apps, live, nowEpochMs }),
      })),
    removeInstance: (key) => modifyRecord(key, () => undefined),
  });
});

export const layer = () => Layer.effect(CtoxAppRail, make());
