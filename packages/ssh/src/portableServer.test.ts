// @effect-diagnostics nodeBuiltinImport:off -- executes the transferred shell in a temporary host fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { vi, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SshCommandError } from "./errors.ts";
import { portableServerPlatform, preparePortableServer } from "./portableServer.ts";

const host = vi.hoisted(() => ({
  root: "",
  corrupt: false,
  transfers: 0,
  archiveBytes: 0,
  commandBytes: 0,
}));
vi.mock("./command.ts", () => ({
  runSshCommand: (
    _target: unknown,
    input: { stdin: string | Uint8Array; remoteCommandArgs?: readonly string[] },
  ) =>
    Effect.try({
      try: () => {
        if (typeof input.stdin === "string" && input.stdin.startsWith("printf"))
          return { stdout: "Linux:x86_64\n", stderr: "" };
        const binary = input.stdin instanceof Uint8Array;
        let content = input.stdin;
        const command = input.remoteCommandArgs?.join(" ") ?? "";
        if (input.stdin instanceof Uint8Array) {
          host.transfers++;
          host.archiveBytes = input.stdin.byteLength;
          host.commandBytes = new TextEncoder().encode(command).byteLength;
          if (host.corrupt) {
            content = Uint8Array.from(input.stdin);
            content[content.length - 1] = (content[content.length - 1] ?? 0) ^ 1;
          }
        }
        const result = NodeChildProcess.spawnSync("/bin/sh", binary ? ["-c", command] : ["-s"], {
          input: content,
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
  host.root = NodePath.join(root, "remote with spaces and 'quotes'");
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
    expect(host.commandBytes).toBeLessThan(4096);
    const archive = yield* (yield* FileSystem.FileSystem).readFile(
      NodePath.join(directory, "workjet-server-linux-x64.tgz"),
    );
    expect(host.archiveBytes).toBe(archive.byteLength);
    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.readFileString(first)).toBe("console.log('fixture');\n");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "transfers an app-sized binary archive with a small installer command",
  () =>
    Effect.gen(function* () {
      const directory = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const payload = NodeCrypto.randomBytes(96 * 1024 * 1024);
      yield* fs.writeFile(NodePath.join(directory, "package/payload.bin"), payload);
      yield* Effect.sync(() =>
        NodeChildProcess.execFileSync(
          "tar",
          [
            "-czf",
            NodePath.join(directory, "workjet-server-linux-x64.tgz"),
            "-C",
            directory,
            "package",
          ],
          { timeout: 60_000 },
        ),
      );
      const installed = yield* preparePortableServer(target, directory, {});
      const restored = yield* fs.readFile(
        NodePath.join(NodePath.dirname(NodePath.dirname(installed)), "payload.bin"),
      );
      expect(NodeCrypto.createHash("sha256").update(restored).digest("hex")).toBe(
        NodeCrypto.createHash("sha256").update(payload).digest("hex"),
      );
      expect(host.archiveBytes).toBeGreaterThanOrEqual(payload.byteLength);
      expect(host.commandBytes).toBeLessThan(4096);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
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
