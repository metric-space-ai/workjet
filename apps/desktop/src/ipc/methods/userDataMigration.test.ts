import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as DesktopUserDataMigration from "../../app/DesktopUserDataMigration.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as IpcChannels from "../channels.ts";
import {
  DesktopUserDataMigrationOfferSchema,
  acceptUserDataMigration,
  declineUserDataMigration,
  getUserDataMigrationOffer,
} from "./userDataMigration.ts";

const decodeOffer = Schema.decodeUnknownEffect(DesktopUserDataMigrationOfferSchema);

interface Recorded {
  readonly accepted: string[];
  readonly declined: string[];
  readonly relaunched: string[];
}

const makeLayer = (
  recorded: Recorded,
  offer: Option.Option<DesktopUserDataMigration.UserDataMigrationOffer>,
) =>
  Layer.mergeAll(
    Layer.succeed(
      DesktopUserDataMigration.DesktopUserDataMigration,
      DesktopUserDataMigration.DesktopUserDataMigration.of({
        decision: Option.match(offer, {
          onNone: () => ({ _tag: "fresh" }) as const,
          onSome: (value) => ({ _tag: "migrate-offer", legacyPath: value.legacyPath }) as const,
        }),
        offer,
        accept: Effect.sync(() => {
          recorded.accepted.push("accept");
        }),
        decline: Effect.sync(() => {
          recorded.declined.push("decline");
        }),
      }),
    ),
    Layer.succeed(
      DesktopLifecycle.DesktopLifecycle,
      DesktopLifecycle.DesktopLifecycle.of({
        register: Effect.void,
        relaunch: (reason) =>
          Effect.sync(() => {
            recorded.relaunched.push(reason);
          }),
      }),
    ),
    unusedLifecycleRuntimeLayer,
  );

// DesktopLifecycle.relaunch declares the full shutdown runtime in its context;
// none of it is reached in these tests.
const unusedLifecycleRuntimeLayer = Layer.mergeAll(
  DesktopShutdown.layer,
  DesktopState.layer,
  Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of(
      {} as DesktopEnvironment.DesktopEnvironment["Service"],
    ),
  ),
  Layer.succeed(
    DesktopWindow.DesktopWindow,
    DesktopWindow.DesktopWindow.of({} as DesktopWindow.DesktopWindow["Service"]),
  ),
  Layer.succeed(
    ElectronApp.ElectronApp,
    ElectronApp.ElectronApp.of({} as ElectronApp.ElectronApp["Service"]),
  ),
  Layer.succeed(
    ElectronTheme.ElectronTheme,
    ElectronTheme.ElectronTheme.of({} as ElectronTheme.ElectronTheme["Service"]),
  ),
);

const emptyRecording = (): Recorded => ({ accepted: [], declined: [], relaunched: [] });

describe("user-data migration IPC contract", () => {
  it("uses stable channel names", () => {
    assert.equal(
      getUserDataMigrationOffer.channel,
      IpcChannels.GET_USER_DATA_MIGRATION_OFFER_CHANNEL,
    );
    assert.equal(acceptUserDataMigration.channel, IpcChannels.ACCEPT_USER_DATA_MIGRATION_CHANNEL);
    assert.equal(declineUserDataMigration.channel, IpcChannels.DECLINE_USER_DATA_MIGRATION_CHANNEL);
  });

  it.effect("returns a decodable offer when one is pending", () => {
    const recorded = emptyRecording();
    const offer = Option.some({
      legacyPath: "/support/t3code",
      targetPath: "/support/CTOX Desktop App",
    });

    return getUserDataMigrationOffer.handler(undefined).pipe(
      Effect.flatMap(decodeOffer),
      Effect.tap((decoded) =>
        Effect.sync(() => {
          assert.isNotNull(decoded);
          assert.equal(decoded?.legacyPath, "/support/t3code");
          assert.equal(decoded?.targetPath, "/support/CTOX Desktop App");
          assert.deepEqual(
            [...(decoded?.entries ?? [])],
            [...DesktopUserDataMigration.USER_DATA_MIGRATION_ALLOWLIST],
          );
        }),
      ),
      Effect.provide(makeLayer(recorded, offer)),
    );
  });

  it.effect("returns null when there is nothing to offer", () => {
    const recorded = emptyRecording();

    return getUserDataMigrationOffer.handler(undefined).pipe(
      Effect.flatMap(decodeOffer),
      Effect.tap((decoded) => Effect.sync(() => assert.isNull(decoded))),
      Effect.provide(makeLayer(recorded, Option.none())),
    );
  });

  it.effect("accepting records the decision and relaunches so the copy runs pre-profile", () => {
    const recorded = emptyRecording();

    return acceptUserDataMigration.handler(undefined).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.deepEqual(recorded.accepted, ["accept"]);
          assert.deepEqual(recorded.relaunched, ["user-data-migration"]);
        }),
      ),
      Effect.provide(
        makeLayer(
          recorded,
          Option.some({ legacyPath: "/support/t3code", targetPath: "/support/CTOX" }),
        ),
      ),
    );
  });

  it.effect("declining records the decision and does not relaunch", () => {
    const recorded = emptyRecording();

    return declineUserDataMigration.handler(undefined).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.deepEqual(recorded.declined, ["decline"]);
          assert.deepEqual(recorded.relaunched, []);
        }),
      ),
      Effect.provide(
        makeLayer(
          recorded,
          Option.some({ legacyPath: "/support/t3code", targetPath: "/support/CTOX" }),
        ),
      ),
    );
  });
});
