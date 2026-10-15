import { CtoxManagedInstance, type CtoxManagedInstance as Instance } from "@workjet/contracts";
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Semaphore } from "effect";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const Document = Schema.Struct({
  version: Schema.Literal(1),
  instances: Schema.Array(CtoxManagedInstance).check(Schema.isMaxLength(1000)),
});
const Json = Schema.fromJsonString(Document);
const encodeDocument = Schema.encodeEffect(Json);
export class PreferenceError extends Schema.TaggedErrorClass<PreferenceError>()(
  "CtoxInstancePreferenceError",
  { code: Schema.Literal("persistence_failed") },
) {}
export class CtoxInstancePreferences extends Context.Service<
  CtoxInstancePreferences,
  {
    readonly read: Effect.Effect<readonly Instance[], PreferenceError>;
    readonly remember: (instances: readonly Instance[]) => Effect.Effect<void, PreferenceError>;
    readonly set: (
      instance: Instance,
      state: "enabled" | "disabled" | "removed",
    ) => Effect.Effect<void, PreferenceError>;
  }
>()("@workjet/desktop/ctox/CtoxInstancePreferences") {}

/** Only local, public descriptors are stored here. Pairing and project data stay untouched. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const directory = path.join(environment.stateDir, "ctox");
  const file = path.join(directory, "instance-preferences.json");
  const read = fs.readFileString(file).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed('{"version":1,"instances":[]}')
          : Effect.fail(new PreferenceError({ code: "persistence_failed" })),
    }),
    Effect.flatMap(Schema.decodeUnknownEffect(Json)),
    Effect.map((document) => document.instances),
    Effect.mapError(() => new PreferenceError({ code: "persistence_failed" })),
  );
  const write = Effect.fn("CtoxInstancePreferences.write")(
    function* (instances: readonly Instance[]) {
      const contents = yield* encodeDocument({ version: 1, instances });
      const temporary = file + "." + process.pid + ".tmp";
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(temporary, contents + "\n", { mode: 0o600 });
      yield* fs.rename(temporary, file);
    },
    Effect.mapError(() => new PreferenceError({ code: "persistence_failed" })),
  );
  return CtoxInstancePreferences.of({
    read,
    remember: (discovered) =>
      lock.withPermit(
        Effect.gen(function* () {
          const previous = yield* read;
          const rows = new Map(previous.map((row) => [row.id, row]));
          for (const instance of discovered)
            rows.set(instance.id, {
              ...instance,
              workjetState: rows.get(instance.id)?.workjetState ?? "enabled",
            });
          const next = [...rows.values()];
          const previousJson = yield* encodeDocument({
            version: 1,
            instances: previous,
          }).pipe(Effect.mapError(() => new PreferenceError({ code: "persistence_failed" })));
          const nextJson = yield* encodeDocument({ version: 1, instances: next }).pipe(
            Effect.mapError(() => new PreferenceError({ code: "persistence_failed" })),
          );
          if (previousJson !== nextJson) yield* write(next);
        }),
      ),
    set: (instance, state) =>
      lock.withPermit(
        Effect.gen(function* () {
          const instances = yield* read;
          const next = [
            ...instances.filter((row) => row.id !== instance.id),
            { ...instance, workjetState: state },
          ];
          yield* write(next);
        }).pipe(Effect.mapError(() => new PreferenceError({ code: "persistence_failed" }))),
      ),
  });
});
export const layer = Layer.effect(CtoxInstancePreferences, make);

/** The production layer supplies this service; older isolated service tests may omit it. */
export const preferences = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(CtoxInstancePreferences);
  return Option.isSome(service) ? yield* service.value.read.pipe(Effect.orDie) : [];
});
export const rememberDiscovery = Effect.fn("CtoxInstancePreferences.rememberDiscovery")(function* (
  instances: readonly Instance[],
) {
  const service = yield* Effect.serviceOption(CtoxInstancePreferences);
  if (Option.isSome(service))
    yield* service.value
      .remember(instances)
      .pipe(Effect.catch(() => Effect.logWarning("Instance preferences could not be persisted.")));
});
export const accessState = (id: string) =>
  preferences.pipe(
    Effect.map((rows) => rows.find((row) => row.id === id)?.workjetState ?? "enabled"),
  );
export const restorePreference = Effect.fn("CtoxInstancePreferences.restorePreference")(function* (
  instance: Instance,
) {
  const service = yield* Effect.serviceOption(CtoxInstancePreferences);
  if (Option.isSome(service)) yield* service.value.set(instance, "enabled");
});

export function applyPreferences(instances: readonly Instance[], stored: readonly Instance[]) {
  const rows = new Map(instances.map((row) => [row.id, row]));
  for (const preference of stored) {
    const current =
      rows.get(preference.id) ??
      (preference.source === "ctox_dev"
        ? {
            ...preference,
            status: "offline" as const,
            healthSummary: { ...preference.healthSummary, dataPlaneReady: false },
          }
        : preference);
    rows.set(preference.id, { ...current, workjetState: preference.workjetState ?? "enabled" });
  }
  return [...rows.values()];
}
