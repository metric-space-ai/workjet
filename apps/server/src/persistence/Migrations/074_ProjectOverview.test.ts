import { assert, it } from "@effect/vitest";
import { ProjectId, type ProjectOverview } from "@workjet/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@workjet/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionProjectRepositoryLive } from "../Layers/ProjectionProjects.ts";

it.effect(
  "adds overview without changing legacy rows and retains all three fields after database reopen",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-project-overview-" });
      const environment = yield* HostProcessEnvironment;
      const platform = yield* HostProcessPlatform;
      // The temporary-root policy applies where a run sets TMPDIR (the Mac build gate points it at
      // /Volumes/tmp). Hosted CI runners leave TMPDIR unset and use the platform temp directory.
      const temporaryRoot = environment.TMPDIR ?? "";
      if (temporaryRoot !== "") {
        if (platform === "darwin") {
          assert.ok(path.resolve(temporaryRoot).startsWith("/Volumes/tmp/"));
        }
        const relative = path.relative(path.resolve(temporaryRoot), directory);
        assert.ok(
          relative !== "" &&
            relative !== ".." &&
            !relative.startsWith("../") &&
            !path.isAbsolute(relative),
        );
      }
      const filename = path.join(directory, "state.sqlite");
      const runtime = () =>
        ProjectionProjectRepositoryLive.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename })),
        );
      const overview: ProjectOverview = {
        archived: true,
        repositoryUrl: "https://github.com/owner/repository",
        websiteUrl: "https://example.org",
        slots: [
          { kind: "text", label: "Phase", value: "Review" },
          { kind: "metric", label: "Entered total", value: 21, unit: "items" },
          { kind: "updated", label: "Changed" },
        ],
      };
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 73 });
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('legacy', 'Legacy', NULL, '[]', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`;
        const before = yield* sql`SELECT * FROM projection_projects WHERE project_id = 'legacy'`;
        assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 74 }), [
          [74, "ProjectOverview"],
        ]);
        // Prepare the post-migration query against the new schema.
        assert.deepEqual(
          yield* sql`SELECT * FROM projection_projects WHERE project_id = 'legacy' LIMIT 1`,
          before.map((row) => ({ ...row, overview_json: null })),
        );
        const repo = yield* ProjectionProjectRepository;
        const existing = yield* repo.getById({ projectId: ProjectId.make("legacy") });
        assert.ok(Option.isSome(existing));
        yield* repo.upsert({ ...existing.value, overview });
      }).pipe(Effect.provide(runtime()));
      yield* Effect.gen(function* () {
        const repo = yield* ProjectionProjectRepository;
        const reopened = yield* repo.getById({ projectId: ProjectId.make("legacy") });
        assert.ok(Option.isSome(reopened));
        assert.deepEqual(reopened.value.overview, overview);
        assert.equal(reopened.value.workspaceRoot, null);
        yield* repo.upsert({ ...reopened.value, title: "Renamed" });
        const renamed = yield* repo.getById({ projectId: ProjectId.make("legacy") });
        assert.ok(Option.isSome(renamed));
        assert.deepEqual(renamed.value.overview, overview);
        yield* repo.upsert({ ...renamed.value, overview: { ...overview, archived: false } });
        const restored = yield* repo.getById({ projectId: ProjectId.make("legacy") });
        assert.ok(Option.isSome(restored));
        assert.deepEqual(restored.value.overview, { ...overview, archived: false });
        yield* repo.upsert({ ...restored.value, overview: null });
        const cleared = yield* repo.getById({ projectId: ProjectId.make("legacy") });
        assert.ok(Option.isSome(cleared));
        assert.equal(cleared.value.overview, null);
        assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 74 }), []);
      }).pipe(Effect.provide(runtime()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
