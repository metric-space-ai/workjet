import * as NodePerfHooks from "node:perf_hooks";
import { NodeServices } from "@effect/platform-node";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import type {
  WorkjetProvisioningSnapshot,
  WorkjetProvisioningStartInput,
} from "@t3tools/contracts";
import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ProvisioningJournal } from "./ProvisioningJournal.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-provisioning-" });
  return { root, fs, path, platform, journal: new ProvisioningJournal(root, platform) };
});
const request: WorkjetProvisioningStartInput = {
  preflightId: "approved-target-1",
  action: "install",
  components: ["ctox-backend"],
  channel: "stable",
};
function snapshot(): WorkjetProvisioningSnapshot {
  return {
    operationId: request.preflightId,
    state: "queued",
    action: request.action,
    components: request.components,
    events: [
      {
        sequence: 0,
        phase: "queued",
        status: "pending",
        percent: 0,
        message: "Queued",
        timestamp: "2026-09-08T09:00:00.000Z",
      },
    ],
    installedVersion: null,
    serviceState: "unknown",
    backendHealthy: false,
    activeConnection: false,
    errorCode: null,
  };
}
const target = { _tag: "local" } as const;

describe("durable provisioning journal", () => {
  it.effect(
    "publishes one launch decision for concurrent duplicate requests and retains the completed result",
    () =>
      Effect.gen(function* () {
        const { root, journal, fs, path, platform } = yield* fixture;
        const decisions = yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: 10 }, () => journal.create(request, target, snapshot())),
          ),
        );
        expect(decisions.filter((entry) => entry.created)).toHaveLength(1);
        const record = decisions[0]!.record;
        yield* Effect.promise(() =>
          journal.save({ ...record, snapshot: { ...record.snapshot, state: "completed" } }),
        );
        const restarted = new ProvisioningJournal(root, platform);
        expect((yield* Effect.promise(() => restarted.replay(request)))?.snapshot.state).toBe(
          "completed",
        );
        const names = yield* fs.readDirectory(journal.directory);
        expect(names).toHaveLength(1);
        if (platform !== "win32") {
          expect((yield* fs.stat(path.join(journal.directory, names[0]!))).mode & 0o777).toBe(
            0o600,
          );
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "preserves uncertain outcomes across real process exit and refuses a changed replay",
    () =>
      Effect.gen(function* () {
        const { root, journal, platform } = yield* fixture;
        const executable = yield* HostProcessExecutablePath;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const moduleUrl = new URL("./ProvisioningJournal.ts", import.meta.url).href;
        const source = `
        import { ProvisioningJournal } from ${encodeJson(moduleUrl)};
        const journal = new ProvisioningJournal(${encodeJson(root)}, ${encodeJson(platform)});
        await journal.create(${encodeJson(request)}, ${encodeJson(target)}, ${encodeJson(snapshot())});
        process.exit(0);
      `;
        const child = yield* spawner.spawn(
          ChildProcess.make(executable, ["--input-type=module", "-e", source]),
        );
        expect(yield* child.exitCode).toBe(0);
        const recovered = yield* Effect.promise(() => journal.replay(request));
        expect(recovered?.snapshot).toMatchObject({
          operationId: request.preflightId,
          state: "interrupted",
          errorCode: "outcome_unknown",
          serviceState: "unknown",
          backendHealthy: false,
          activeConnection: false,
        });
        expect(
          (yield* Effect.promise(() => journal.create(request, target, snapshot()))).created,
        ).toBe(false);
        yield* Effect.promise(() =>
          expect(journal.replay({ ...request, action: "rollback" })).rejects.toThrow(
            "different operation",
          ),
        );
        expect((yield* Effect.promise(() => journal.list()))[0]?.snapshot.state).toBe(
          "interrupted",
        );
        yield* Effect.promise(() =>
          expect(journal.save(recovered!)).rejects.toThrow("cannot resume"),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not erase a malformed durable record or convert it to not-found", () =>
    Effect.gen(function* () {
      const { journal, fs, path } = yield* fixture;
      yield* Effect.promise(() => journal.create(request, target, snapshot()));
      const filename = path.join(
        journal.directory,
        (yield* fs.readDirectory(journal.directory))[0]!,
      );
      yield* fs.writeFileString(filename, '{"version":');
      yield* Effect.promise(() => expect(journal.get(request.preflightId)).rejects.toThrow());
      yield* Effect.promise(() =>
        expect(journal.create(request, target, snapshot())).rejects.toThrow(),
      );
      expect(yield* fs.readFileString(filename)).toBe('{"version":');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops serving stale running state after a persistence failure", () =>
    Effect.gen(function* () {
      const { root, journal, fs, platform } = yield* fixture;
      const { record } = yield* Effect.promise(() => journal.create(request, target, snapshot()));
      yield* fs.rename(journal.directory, journal.directory + "-saved");
      yield* fs.writeFileString(journal.directory, "not a directory");
      yield* Effect.promise(() =>
        expect(
          journal.save({ ...record, snapshot: { ...record.snapshot, state: "completed" } }),
        ).rejects.toThrow(),
      );
      yield* Effect.promise(() =>
        expect(journal.get(request.preflightId)).rejects.toThrow("persistence failed"),
      );
      yield* Effect.promise(() => expect(journal.list()).rejects.toThrow("persistence failed"));
      yield* Effect.promise(() =>
        expect(journal.create(request, target, snapshot())).rejects.toThrow("persistence failed"),
      );
      yield* fs.remove(journal.directory);
      yield* fs.rename(journal.directory + "-saved", journal.directory);
      expect(
        (yield* Effect.promise(() =>
          new ProvisioningJournal(root, platform).get(request.preflightId),
        ))?.snapshot.state,
      ).toBe("interrupted");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects invalid evidence before publication, with no executable operation", () =>
    Effect.gen(function* () {
      const { journal } = yield* fixture;
      yield* Effect.promise(() =>
        expect(
          journal.create(request, target, { ...snapshot(), operationId: "../another" }),
        ).rejects.toThrow(),
      );
      expect(yield* Effect.promise(() => journal.list())).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports local persistence latency separately from sync and execution latency", () =>
    Effect.gen(function* () {
      const { journal } = yield* fixture;
      const samples: number[] = [];
      for (let index = 0; index < 30; index += 1) {
        const input = { ...request, preflightId: "measured-" + index };
        const begin = NodePerfHooks.performance.now();
        yield* Effect.promise(() =>
          journal.create(input, target, { ...snapshot(), operationId: input.preflightId }),
        );
        samples.push(NodePerfHooks.performance.now() - begin);
      }
      samples.sort((a, b) => a - b);
      const begin = NodePerfHooks.performance.now();
      expect(yield* Effect.promise(() => journal.list())).toHaveLength(30);
      yield* Effect.log(
        encodeJson({
          measurement: "local-provisioning-journal",
          samples: samples.length,
          samplesMs: samples,
          durableCreateP50Ms: samples[14],
          durableCreateP95Ms: samples[28],
          list30Ms: NodePerfHooks.performance.now() - begin,
          includesNetworkOrInstaller: false,
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
