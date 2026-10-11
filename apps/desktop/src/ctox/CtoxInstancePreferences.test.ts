import { DatabaseSync } from "node:sqlite";
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
        yield* Effect.sync(() => {
          const database = new DatabaseSync(projects);
          try {
            database.exec(
              "CREATE TABLE projection_projects (id TEXT PRIMARY KEY); CREATE TABLE projection_threads (id TEXT PRIMARY KEY, project_id TEXT); INSERT INTO projection_projects VALUES ('fixture-project'); INSERT INTO projection_threads VALUES ('fixture-thread', 'fixture-project');",
            );
          } finally {
            database.close();
          }
        });
        const before = yield* fs.readFile(projects);
        const create = make.pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
            stateDir: directory,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        );
        const first = yield* create;
        yield* first.remember([instance]);
        yield* first.set(instance, "disabled");
        yield* first.remember([{ ...instance, displayName: "Updated fixture" }]);
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
        assert.deepEqual(yield* fs.readFile(projects), before);
        yield* Effect.sync(() => {
          const database = new DatabaseSync(projects, { readOnly: true });
          try {
            assert.equal(
              database.prepare("SELECT id FROM projection_projects").get()?.id,
              "fixture-project",
            );
            assert.equal(
              database.prepare("SELECT id FROM projection_threads").get()?.id,
              "fixture-thread",
            );
          } finally {
            database.close();
          }
        });
        assert.equal(applyPreferences([], yield* reopened.read)[0]?.id, instance.id);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
