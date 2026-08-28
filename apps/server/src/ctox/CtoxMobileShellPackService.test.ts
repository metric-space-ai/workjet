import { assert, describe, it } from "@effect/vitest";
import type { CtoxMobileShellPackResolveResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ShellPacks from "./CtoxMobileShellPackService.ts";

const encoder = new TextEncoder();
const valid: CtoxMobileShellPackResolveResult = {
  type: "ctox.mobile.shell-pack-distribution.v1",
  manifest: {
    type: "ctox.mobile.shell-pack.v1",
    packId: "pack-a",
    businessOsRevision: "revision-a",
    appVersion: "1.0.0",
    totalSize: 1,
    files: [{ path: "index.html", size: 1, sha256: "a".repeat(64) }],
    signingKeyId: "key-current",
    signature: "b".repeat(128),
  },
  artifact: {
    url: "https://releases.example.test/pack.tar.zst",
    size: 1,
    sha256: "c".repeat(64),
    contentType: "application/zstd",
    expiresAt: "2099-08-25T12:05:00.000Z",
  },
};

function layer(stdout: string, commands: ReadonlyArray<ReadonlyArray<string>>) {
  const spawner = ChildProcessSpawner.make((command) => {
    const child = command as unknown as { readonly args: ReadonlyArray<string> };
    (commands as ReadonlyArray<string>[]).push(child.args);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return ShellPacks.layer({
    env: {},
    nowEpochMs: () => Date.parse("2026-08-25T12:00:00.000Z"),
  }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)));
}

describe("CtoxMobileShellPackService", () => {
  it.effect("resolves the exact app/revision pair through the native CLI", () => {
    const commands: ReadonlyArray<string>[] = [];
    return Effect.gen(function* () {
      const service = yield* ShellPacks.CtoxMobileShellPackService;
      assert.deepEqual(yield* service.resolve("revision-a", "1.0.0"), valid);
      assert.deepEqual(commands, [
        [
          "business-os",
          "mobile-shell",
          "resolve",
          "--business-os-revision",
          "revision-a",
          "--app-version",
          "1.0.0",
        ],
      ]);
    }).pipe(Effect.provide(layer(JSON.stringify(valid), commands)));
  });

  it.effect("fails closed for duplicate paths and an expired artifact URL", () =>
    Effect.gen(function* () {
      const service = yield* ShellPacks.CtoxMobileShellPackService;
      const error = yield* Effect.flip(service.resolve("revision-a", "1.0.0"));
      assert.equal(error.reason, "invalid_response");
    }).pipe(
      Effect.provide(
        layer(
          JSON.stringify({
            ...valid,
            manifest: {
              ...valid.manifest,
              totalSize: 2,
              files: [valid.manifest.files[0], valid.manifest.files[0]],
            },
            artifact: { ...valid.artifact, expiresAt: "2020-01-01T00:00:00.000Z" },
          }),
          [],
        ),
      ),
    ),
  );
});
