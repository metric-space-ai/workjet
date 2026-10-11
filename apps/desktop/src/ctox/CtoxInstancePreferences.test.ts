import { vi } from "vite-plus/test";
vi.mock("electron", () => ({}));
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  make,
  accessState,
  CtoxInstancePreferences,
  applyPreferences,
} from "./CtoxInstancePreferences.ts";
import type { CtoxManagedInstance } from "@workjet/contracts";

const instance: CtoxManagedInstance = {
  id: "managed:fixture",
  source: "ctox_dev",
  displayName: "Fixture",
  status: "available",
  healthSummary: {
    dataPlane: "rxdb-webrtc",
    dataPlaneReady: false,
    httpDataProxy: false,
    nativePeerObserved: false,
  },
};
describe("instance preferences", () => {
  it.effect(
    "persists disable, remove and restore across restart without touching project data",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "instance-preferences-" });
        const projects = path.join(directory, "state.sqlite");
        yield* fs.writeFileString(projects, "preserved-projects-and-threads");
        const create = make.pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
            stateDir: directory,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        );
        const first = yield* create;
        yield* first.set(instance, "disabled");
        const reopened = yield* create;
        assert.equal(
          yield* accessState(instance.id).pipe(
            Effect.provideService(CtoxInstancePreferences, reopened),
          ),
          "disabled",
        );
        yield* reopened.set(instance, "removed");
        const removed = yield* create;
        assert.equal((yield* removed.read)[0]?.workjetState, "removed");
        yield* removed.set(instance, "enabled");
        const restored = yield* create;
        assert.equal((yield* restored.read)[0]?.workjetState, "enabled");
        assert.equal(yield* fs.readFileString(projects), "preserved-projects-and-threads");
        assert.equal(applyPreferences([], yield* reopened.read)[0]?.id, instance.id);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
