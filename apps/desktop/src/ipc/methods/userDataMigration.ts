import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopUserDataMigration from "../../app/DesktopUserDataMigration.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

/**
 * Payload for the one-time "import your previous T3 Code data?" prompt. Null
 * means: nothing to offer (fresh install, or already decided once).
 */
export const DesktopUserDataMigrationOfferSchema = Schema.NullOr(
  Schema.Struct({
    legacyPath: Schema.String,
    targetPath: Schema.String,
    /** Top-level entries the import would copy. The legacy directory is never modified. */
    entries: Schema.Array(Schema.String),
  }),
);
export type DesktopUserDataMigrationOffer = typeof DesktopUserDataMigrationOfferSchema.Type;

export const getUserDataMigrationOffer = makeIpcMethod({
  channel: IpcChannels.GET_USER_DATA_MIGRATION_OFFER_CHANNEL,
  payload: Schema.Void,
  result: DesktopUserDataMigrationOfferSchema,
  handler: Effect.fn("desktop.ipc.userDataMigration.getOffer")(function* () {
    const migration = yield* DesktopUserDataMigration.DesktopUserDataMigration;
    return Option.match(migration.offer, {
      onNone: () => null,
      onSome: (offer) => ({
        legacyPath: offer.legacyPath,
        targetPath: offer.targetPath,
        entries: DesktopUserDataMigration.USER_DATA_MIGRATION_ALLOWLIST,
      }),
    });
  }),
});

export const acceptUserDataMigration = makeIpcMethod({
  channel: IpcChannels.ACCEPT_USER_DATA_MIGRATION_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  // Acceptance is recorded, then the app relaunches: the copy runs on the next
  // launch, before Chromium opens the profile it writes into.
  handler: Effect.fn("desktop.ipc.userDataMigration.accept")(function* () {
    const migration = yield* DesktopUserDataMigration.DesktopUserDataMigration;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* migration.accept;
    yield* lifecycle.relaunch("user-data-migration");
  }),
});

export const declineUserDataMigration = makeIpcMethod({
  channel: IpcChannels.DECLINE_USER_DATA_MIGRATION_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.userDataMigration.decline")(function* () {
    const migration = yield* DesktopUserDataMigration.DesktopUserDataMigration;
    yield* migration.decline;
  }),
});
