import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodePerfHooks from "node:perf_hooks";
import { afterEach, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import type {
  WorkjetProvisioningSnapshot,
  WorkjetProvisioningStartInput,
} from "@t3tools/contracts";
import { ProvisioningJournal } from "./ProvisioningJournal.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

const roots: string[] = [];
async function fixture(platform: NodeJS.Platform) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-provisioning-"));
  roots.push(root);
  return { root, journal: new ProvisioningJournal(root, platform) };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
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
        const platform = yield* HostProcessPlatform;
        yield* Effect.promise(async () => {
          const { root, journal } = await fixture(platform);
          const decisions = await Promise.all(
            Array.from({ length: 10 }, () => journal.create(request, target, snapshot())),
          );
          expect(decisions.filter((entry) => entry.created)).toHaveLength(1);
          const record = decisions[0]!.record;
          await journal.save({ ...record, snapshot: { ...record.snapshot, state: "completed" } });
          const restarted = new ProvisioningJournal(root, platform);
          expect((await restarted.replay(request))?.snapshot.state).toBe("completed");
          expect(await NodeFSP.readdir(journal.directory)).toHaveLength(1);
          if (platform !== "win32") {
            const filename = (await NodeFSP.readdir(journal.directory))[0]!;
            expect(
              (await NodeFSP.stat(NodePath.join(journal.directory, filename))).mode & 0o777,
            ).toBe(0o600);
          }
        });
      }),
  );

  it.effect(
    "preserves uncertain outcomes across real process exit and refuses a changed replay",
    () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        yield* Effect.promise(async () => {
          const { root, journal } = await fixture(platform);
          const moduleUrl = new URL("./ProvisioningJournal.ts", import.meta.url).href;
          const source = `
      import { ProvisioningJournal } from ${JSON.stringify(moduleUrl)};
      const journal = new ProvisioningJournal(${JSON.stringify(root)}, ${JSON.stringify(platform)});
      await journal.create(${JSON.stringify(request)}, ${JSON.stringify(target)}, ${JSON.stringify(snapshot())});
      process.exit(0);
    `;
          await NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, [
            "--input-type=module",
            "-e",
            source,
          ]);
          const recovered = await journal.replay(request);
          expect(recovered?.snapshot).toMatchObject({
            operationId: request.preflightId,
            state: "interrupted",
            errorCode: "outcome_unknown",
            serviceState: "unknown",
            backendHealthy: false,
            activeConnection: false,
          });
          expect((await journal.create(request, target, snapshot())).created).toBe(false);
          await expect(journal.replay({ ...request, action: "rollback" })).rejects.toThrow(
            "different operation",
          );
          expect((await journal.list())[0]?.snapshot.state).toBe("interrupted");
          await expect(journal.save(recovered!)).rejects.toThrow("cannot resume");
        });
      }),
  );

  it.effect("does not erase a malformed durable record or convert it to not-found", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const { journal } = await fixture(platform);
        await journal.create(request, target, snapshot());
        const filename = NodePath.join(
          journal.directory,
          (await NodeFSP.readdir(journal.directory))[0]!,
        );
        await NodeFSP.writeFile(filename, '{"version":');
        await expect(journal.get(request.preflightId)).rejects.toThrow();
        await expect(journal.create(request, target, snapshot())).rejects.toThrow();
        expect(await NodeFSP.readFile(filename, "utf8")).toBe('{"version":');
      });
    }),
  );

  it.effect("stops serving stale running state after a persistence failure", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const { root, journal } = await fixture(platform);
        const { record } = await journal.create(request, target, snapshot());
        await NodeFSP.rename(journal.directory, journal.directory + "-saved");
        await NodeFSP.writeFile(journal.directory, "not a directory");
        await expect(
          journal.save({ ...record, snapshot: { ...record.snapshot, state: "completed" } }),
        ).rejects.toThrow();
        await expect(journal.get(request.preflightId)).rejects.toThrow("persistence failed");
        await expect(journal.list()).rejects.toThrow("persistence failed");
        await expect(journal.create(request, target, snapshot())).rejects.toThrow(
          "persistence failed",
        );
        await NodeFSP.rm(journal.directory);
        await NodeFSP.rename(journal.directory + "-saved", journal.directory);
        expect(
          (await new ProvisioningJournal(root, platform).get(request.preflightId))?.snapshot.state,
        ).toBe("interrupted");
      });
    }),
  );

  it.effect("rejects invalid evidence before publication, with no executable operation", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const { journal } = await fixture(platform);
        await expect(
          journal.create(request, target, { ...snapshot(), operationId: "../another" }),
        ).rejects.toThrow();
        expect(await journal.list()).toEqual([]);
      });
    }),
  );

  it.effect("reports local persistence latency separately from sync and execution latency", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const { journal } = await fixture(platform);
        const samples: number[] = [];
        for (let index = 0; index < 30; index += 1) {
          const input = { ...request, preflightId: "measured-" + index };
          const begin = NodePerfHooks.performance.now();
          await journal.create(input, target, { ...snapshot(), operationId: input.preflightId });
          samples.push(NodePerfHooks.performance.now() - begin);
        }
        samples.sort((a, b) => a - b);
        const begin = NodePerfHooks.performance.now();
        expect(await journal.list()).toHaveLength(30);
        console.log(
          JSON.stringify({
            measurement: "local-provisioning-journal",
            samples: samples.length,
            durableCreateP50Ms: samples[14],
            durableCreateP95Ms: samples[28],
            list30Ms: NodePerfHooks.performance.now() - begin,
            includesNetworkOrInstaller: false,
          }),
        );
      });
    }),
  );
});
