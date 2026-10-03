// @effect-diagnostics nodeBuiltinImport:off -- executes the transferred shell in a temporary host fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { vi, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SshCommandError } from "./errors.ts";
import { portableServerPlatform, preparePortableServer } from "./portableServer.ts";

const host = vi.hoisted(() => ({ root: "", corrupt: false, transfers: 0 }));
vi.mock("./command.ts", () => ({
  runSshCommand: (_target: unknown, input: { stdin: string }) =>
    Effect.try({
      try: () => {
        if (input.stdin.startsWith("printf")) return { stdout: "Linux:x86_64\n", stderr: "" };
        let script = input.stdin;
        if (script.includes("WORKJET_ARCHIVE")) {
          host.transfers++;
          if (host.corrupt)
            script = script.replace(
              /(test "\$\{actual%% \*\}" = ')[a-f0-9]{64}/,
              "$1" + "0".repeat(64),
            );
        }
        const result = NodeChildProcess.spawnSync("/bin/sh", ["-s"], {
          input: script,
          env: { ...process.env, HOME: host.root },
          encoding: "utf8",
          timeout: 30_000,
        });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(result.stderr);
        return { stdout: result.stdout, stderr: result.stderr };
      },
      catch: (cause) =>
        new SshCommandError({
          message: String(cause),
          cause,
          command: ["fixture"],
          exitCode: 1,
          stderr: "",
        }),
    }),
}));

const target = { alias: "fixture", hostname: "fixture", username: null, port: null };
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-portable-server-" });
  host.root = NodePath.join(root, "remote");
  host.transfers = 0;
  host.corrupt = false;
  yield* fs.makeDirectory(host.root);
  yield* fs.makeDirectory(NodePath.join(root, "package/dist"), { recursive: true });
  yield* fs.writeFileString(
    NodePath.join(root, "package/dist/bin.mjs"),
    "console.log('fixture');\n",
  );
  yield* Effect.sync(() =>
    NodeChildProcess.execFileSync("tar", [
      "-czf",
      NodePath.join(root, "workjet-server-linux-x64.tgz"),
      "-C",
      root,
      "package",
    ]),
  );
  return root;
});

it.effect("transfers and verifies the app's server once, then reuses it", () =>
  Effect.gen(function* () {
    const directory = yield* fixture;
    const first = yield* preparePortableServer(target, directory, {});
    const second = yield* preparePortableServer(target, directory, {});
    expect(first).toBe(second);
    expect(first).toMatch(/\.workjet\/ssh-server\/[a-f0-9]{64}\/package\/dist\/bin\.mjs$/);
    expect(host.transfers).toBe(1);
    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.readFileString(first)).toBe("console.log('fixture');\n");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a transfer with a mismatched checksum and leaves no installed server", () =>
  Effect.gen(function* () {
    const directory = yield* fixture;
    host.corrupt = true;
    const result = yield* preparePortableServer(target, directory, {}).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure.message).toContain("transfer checksum verification failed");

    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.readDirectory(NodePath.join(host.root, ".workjet/ssh-server"))).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("only selects bundled archives for known platform identifiers", () => {
  expect(portableServerPlatform("Linux:x86_64\n")).toBe("linux-x64");
  expect(portableServerPlatform("../../other")).toBeUndefined();
});
