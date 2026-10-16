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
import {
  PORTABLE_SERVER_CHUNK_BYTES,
  PORTABLE_SERVER_STALLED_ATTEMPTS,
  portableServerPlatform,
  preparePortableServer,
} from "./portableServer.ts";

const host = vi.hoisted(() => ({
  root: "",
  corrupt: false,
  transfers: 0,
  archiveBytes: 0,
  commandBytes: 0,
  /** Cut the next N binary chunks after half their bytes (a timed-out chunk). */
  cutChunks: 0,
  /** Every binary chunk arrives with zero bytes and times out. */
  dropChunks: false,
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
        let cut = false;
        if (input.stdin instanceof Uint8Array) {
          host.transfers++;
          host.archiveBytes += input.stdin.byteLength;
          host.commandBytes = Math.max(
            host.commandBytes,
            new TextEncoder().encode(command).byteLength,
          );
          if (host.corrupt) {
            content = Uint8Array.from(input.stdin);
            content[content.length - 1] = (content[content.length - 1] ?? 0) ^ 1;
          }
          if (host.cutChunks > 0) {
            host.cutChunks--;
            cut = true;
            content = input.stdin.subarray(0, Math.floor(input.stdin.byteLength / 2));
          }
          if (host.dropChunks) {
            cut = true;
            content = new Uint8Array();
          }
        }
        const result = NodeChildProcess.spawnSync("/bin/sh", binary ? ["-c", command] : ["-s"], {
          input: content,
          env: { ...process.env, HOME: host.root },
          encoding: "utf8",
          timeout: 30_000,
        });
        if (result.error) throw result.error;
        if (cut) throw new Error("SSH command timed out after 120000ms.");
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
  host.archiveBytes = 0;
  host.commandBytes = 0;
  host.cutChunks = 0;
  host.dropChunks = false;
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
      // Bounded chunks, each with its own timeout, instead of one 100 MB command.
      expect(host.transfers).toBeGreaterThan(payload.byteLength / PORTABLE_SERVER_CHUNK_BYTES);
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

const writeArchive = (directory: string, bytes: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFile(
      NodePath.join(directory, "package/payload.bin"),
      NodeCrypto.randomBytes(bytes),
    );
    yield* Effect.sync(() =>
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        NodePath.join(directory, "workjet-server-linux-x64.tgz"),
        "-C",
        directory,
        "package",
      ]),
    );
    return yield* fs.readFile(NodePath.join(directory, "workjet-server-linux-x64.tgz"));
  });

it.effect("resumes a cut chunk at the size the host reports and reports progress", () =>
  Effect.gen(function* () {
    const directory = yield* fixture;
    const archive = yield* writeArchive(directory, 3 * PORTABLE_SERVER_CHUNK_BYTES);
    host.cutChunks = 2;
    const progress: number[] = [];
    const installed = yield* preparePortableServer(target, directory, {}, (step) =>
      Effect.sync(() => progress.push(step.transferredBytes)),
    );
    expect(installed).toMatch(/package\/dist\/bin\.mjs$/);
    // Cut chunks are not resent from zero: only the missing halves travel again.
    expect(host.archiveBytes).toBeLessThan(archive.byteLength + PORTABLE_SERVER_CHUNK_BYTES * 1.5);
    expect(progress.at(-1)).toBe(archive.byteLength);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    const fs = yield* FileSystem.FileSystem;
    const leftovers = (yield* fs.readDirectory(
      NodePath.join(host.root, ".workjet/ssh-server"),
    )).filter((name) => name.startsWith("."));
    expect(leftovers).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("continues an earlier interrupted transfer instead of starting over", () =>
  Effect.gen(function* () {
    const directory = yield* fixture;
    const archive = yield* writeArchive(directory, 2 * PORTABLE_SERVER_CHUNK_BYTES);
    const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
    const fs = yield* FileSystem.FileSystem;
    const dir = NodePath.join(host.root, ".workjet/ssh-server");
    yield* fs.makeDirectory(dir, { recursive: true });
    const already = PORTABLE_SERVER_CHUNK_BYTES + 12_345;
    yield* fs.writeFile(NodePath.join(dir, `.partial-${digest}.tgz`), archive.subarray(0, already));
    yield* preparePortableServer(target, directory, {});
    expect(host.archiveBytes).toBe(archive.byteLength - already);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails with a resumable stall message after bounded attempts without progress", () =>
  Effect.gen(function* () {
    const directory = yield* fixture;
    host.dropChunks = true;
    const result = yield* preparePortableServer(target, directory, {}).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toMatch(/transfer stalled at \d+ MB of \d+ MB/u);
      expect(result.failure.message).toContain("Retry resumes");
    }
    expect(host.transfers).toBe(PORTABLE_SERVER_STALLED_ATTEMPTS);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("only selects bundled archives for known platform identifiers", () => {
  expect(portableServerPlatform("Linux:x86_64\n")).toBe("linux-x64");
  expect(portableServerPlatform("../../other")).toBeUndefined();
});
