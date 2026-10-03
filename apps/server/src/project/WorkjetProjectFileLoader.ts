/**
 * WorkjetProjectFileLoader - Effect service that loads the checked-in `workjet.json`
 * project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module WorkjetProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { WORKJET_PROJECT_FILE_NAME, type WorkjetProjectFile } from "@workjet/contracts";
import { WorkjetProjectFileFromJson } from "@workjet/shared/workjetProjectFile";

const decodeWorkjetProjectFileJson = Schema.decodeEffect(WorkjetProjectFileFromJson);

export class WorkjetProjectFileLoadError extends Schema.TaggedErrorClass<WorkjetProjectFileLoadError>()(
  "WorkjetProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${WORKJET_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for workjet.json project file loading. */
export class WorkjetProjectFileLoader extends Context.Service<
  WorkjetProjectFileLoader,
  {
    /**
     * Load and decode `workjet.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<WorkjetProjectFile>>;
  }
>()("workjet/project/WorkjetProjectFileLoader") {}

const logWorkjetProjectFileLoadError = (error: WorkjetProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: WorkjetProjectFileLoader["Service"]["load"] = Effect.fn(
    "WorkjetProjectFileLoader.load",
  )(function* (workspaceRoot) {
    const filePath = path.join(workspaceRoot, WORKJET_PROJECT_FILE_NAME);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : logWorkjetProjectFileLoadError(
                new WorkjetProjectFileLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause: error,
                }),
              ).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<WorkjetProjectFile>();
    }
    return yield* decodeWorkjetProjectFileJson(raw.value).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        SchemaError: (error) =>
          logWorkjetProjectFileLoadError(
            new WorkjetProjectFileLoadError({
              operation: "decode",
              workspaceRoot,
              filePath,
              cause: error,
            }),
          ).pipe(Effect.as(Option.none<WorkjetProjectFile>())),
      }),
    );
  });

  return WorkjetProjectFileLoader.of({ load });
});

export const layer = Layer.effect(WorkjetProjectFileLoader, make);
