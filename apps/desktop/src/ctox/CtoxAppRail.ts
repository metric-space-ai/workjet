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

const RAIL_VERSION = 1;
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
const RailCachedApp = Schema.Struct({
  id: RailModuleId,
  title: Schema.optionalKey(RailAppTitle),
  lastSeenAt: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
type RailCachedApp = typeof RailCachedApp.Type;
const RailInstanceRecord = Schema.Struct({
  instanceId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512)),
  docked: Schema.Array(RailModuleId).check(Schema.isMaxLength(MAX_DOCKED_APPS)),
  apps: Schema.Array(RailCachedApp).check(Schema.isMaxLength(MAX_RAIL_APPS)),
});
type RailInstanceRecord = typeof RailInstanceRecord.Type;
const RailDocument = Schema.Struct({
  version: Schema.Literal(RAIL_VERSION),
  instances: Schema.Array(RailInstanceRecord).check(Schema.isMaxLength(MAX_RAIL_INSTANCES)),
});
type RailDocument = typeof RailDocument.Type;
const RailDocumentJson = Schema.fromJsonString(RailDocument);

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
}

export interface CtoxRailInstanceState {
  readonly docked: readonly string[];
  readonly apps: readonly RailCachedApp[];
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
    const lastSeenAt = input.live !== undefined ? input.nowEpochMs : cached?.lastSeenAt;
    rows.push({
      id,
      ...(title === undefined ? {} : { title }),
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
    next.set(app.id, {
      id: app.id,
      ...(title === undefined ? {} : { title }),
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
      instanceId: string,
    ) => Effect.Effect<CtoxRailInstanceState, CtoxAppRailError>;
    readonly setDocked: (
      instanceId: string,
      moduleId: string,
      docked: boolean,
    ) => Effect.Effect<void, CtoxAppRailError>;
    readonly recordLiveApps: (
      instanceId: string,
      live: readonly CtoxLiveGuestApp[],
      nowEpochMs: number,
    ) => Effect.Effect<void, CtoxAppRailError>;
    readonly removeInstance: (instanceId: string) => Effect.Effect<void, CtoxAppRailError>;
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
    return yield* Schema.decodeEffect(RailDocumentJson)(contents.trim()).pipe(
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

  const modifyRecord = (
    instanceId: string,
    update: (record: RailInstanceRecord) => RailInstanceRecord | undefined,
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        const document = yield* readDocument();
        const existing = document.instances.find((record) => record.instanceId === instanceId);
        const updated = update(existing ?? { instanceId, docked: [], apps: [] });
        const others = document.instances.filter((record) => record.instanceId !== instanceId);
        const instances =
          updated === undefined ? others : [...others, updated].slice(0, MAX_RAIL_INSTANCES);
        yield* writeDocument({ version: RAIL_VERSION, instances });
      }),
    );

  return CtoxAppRail.of({
    stateForInstance: (instanceId) =>
      lock.withPermit(
        Effect.gen(function* () {
          const document = yield* readDocument();
          const record = document.instances.find((entry) => entry.instanceId === instanceId);
          return { docked: record?.docked ?? [], apps: record?.apps ?? [] };
        }),
      ),
    setDocked: (instanceId, moduleId, docked) =>
      modifyRecord(instanceId, (record) => {
        const withoutModule = record.docked.filter((id) => id !== moduleId);
        const nextDocked = docked
          ? [...withoutModule, moduleId].slice(-MAX_DOCKED_APPS)
          : withoutModule;
        return { ...record, docked: nextDocked };
      }),
    recordLiveApps: (instanceId, live, nowEpochMs) =>
      modifyRecord(instanceId, (record) => ({
        ...record,
        apps: refreshRailCache({ cached: record.apps, live, nowEpochMs }),
      })),
    removeInstance: (instanceId) => modifyRecord(instanceId, () => undefined),
  });
});

export const layer = () => Layer.effect(CtoxAppRail, make());
