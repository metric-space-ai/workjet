// @effect-diagnostics nodeBuiltinImport:off -- Inspect capture of actual fixture executable files without a provider account.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@workjet/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { WorkerNamespaceSessionCapture } from "../../workjet/WorkerSourceNamespace.ts";
import { prepareClaudeNamespaceSpawn } from "./ClaudeNamespaceSpawn.ts";

function capture(
  callbacks: Pick<WorkerNamespaceSessionCapture, "revalidate" | "captureRuntime">,
): WorkerNamespaceSessionCapture {
  return {
    helperPath: "/runtime/workjet-resource-monitor",
    worktree: {
      kind: "isolated",
      worktreePath: "/assigned/worker",
      worktreeDev: "1",
      worktreeIno: "2",
      adminPath: "/assigned/worker/.git",
      adminDev: "1",
      adminIno: "3",
    },
    profile: { path: "/runtime/profiles/worker", identity: { device: "1", inode: "4" } },
    modelSocket: {
      root: "/runtime/model-ipc",
      path: "/proc/111/fd/12/s",
      directory: "/runtime/model-ipc/m-worker",
      directoryIdentity: { device: "1", inode: "5" },
      socketIdentity: { device: "1", inode: "6" },
      hostNetworkIdentity: { device: "7", inode: "8" },
    },
    ...callbacks,
  };
}
const input = (signal = new AbortController().signal): SpawnOptions => ({
  command: "/usr/bin/true",
  args: ["--sdk-argument"],
  cwd: "/assigned/worker",
  env: { WORKJET_SOURCE_ISOLATED: "true" },
  signal,
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcessPlatform, "linux"),
  );

describe("Claude SDK namespace preparation", () => {
  it.effect(
    "admits before capture and revalidates after persisting original executable identity",
    () =>
      provide(
        Effect.gen(function* () {
          const calls: string[] = [];
          const command = yield* Effect.promise(() => NodeFSP.realpath("/usr/bin/true"));
          const prepared = yield* prepareClaudeNamespaceSpawn(
            input(),
            capture({
              revalidate: async () => {
                calls.push("admit");
              },
              captureRuntime: async (runtime) => {
                calls.push("capture");
                expect(runtime.command).toBe(command);
                expect(runtime.runtimeFiles.map((file) => file.path)).toEqual([command]);
              },
            }),
          );
          expect(calls).toEqual(["admit", "capture", "admit"]);
          expect(prepared.command).toBe("/runtime/workjet-resource-monitor");
          expect(prepared.args.slice(2)).toEqual(["--", command, "--sdk-argument"]);
          expect(prepared.env).toEqual({ WORKJET_SOURCE_ISOLATED: "true" });
        }),
      ),
  );

  it.effect("withholds launch when the persisted runtime rejects a replacement", () =>
    provide(
      Effect.gen(function* () {
        let admissions = 0;
        const result = yield* prepareClaudeNamespaceSpawn(
          input(),
          capture({
            revalidate: async () => {
              admissions++;
            },
            captureRuntime: async () => {
              throw new Error("Original runtime mismatch");
            },
          }),
        ).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { issue: expect.stringContaining("original persisted Source custody") },
        });
        expect(admissions).toBe(1);
      }),
    ),
  );

  it.effect("withholds launch when Source is revoked during capture", () =>
    provide(
      Effect.gen(function* () {
        let admissions = 0;
        const result = yield* prepareClaudeNamespaceSpawn(
          input(),
          capture({
            revalidate: async () => {
              admissions++;
              if (admissions === 2) throw new Error("Source revoked");
            },
            captureRuntime: async () => {},
          }),
        ).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { issue: expect.stringContaining("admission failed") },
        });
        expect(admissions).toBe(2);
      }),
    ),
  );

  it.effect("requires the production runtime journal rather than accepting path observations", () =>
    provide(
      Effect.gen(function* () {
        const result = yield* prepareClaudeNamespaceSpawn(
          input(),
          capture({
            revalidate: async () => {
              throw new Error("Must not admit without a journal");
            },
          }),
        ).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { issue: expect.stringContaining("original persisted Source runtime") },
        });
      }),
    ),
  );

  it.effect("captures the SDK's Node entry file with command-first custody", () =>
    provide(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "wj-claude-entry-" });
          const entry = NodePath.join(
            yield* Effect.promise(() => NodeFSP.realpath(root)),
            "cli.js",
          );
          yield* fs.writeFileString(entry, "process.exit(0);");
          const node = yield* Effect.promise(() => NodeFSP.realpath(process.execPath));
          const prepared = yield* prepareClaudeNamespaceSpawn(
            {
              ...input(),
              command: process.execPath,
              args: [entry, "--sdk-argument"],
            },
            capture({
              revalidate: async () => {},
              captureRuntime: async (runtime) => {
                expect(runtime.command).toBe(node);
                expect(runtime.runtimeFiles.map((file) => file.path)).toEqual([node, entry]);
              },
            }),
          );
          expect(prepared.args.slice(2)).toEqual(["--", node, entry, "--sdk-argument"]);
        }),
      ),
    ),
  );
});
