// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { runCommand } from "./workerRun.ts";
for (const args of [
  ["--pool", "worker", "Worker name", "--brief", "Task", "--url", "http://127.0.0.1:12345/mcp"],
  [
    "--pool",
    "worker",
    "--brief",
    "Task",
    "--brief-file",
    "unused.txt",
    "--url",
    "http://127.0.0.1:12345/mcp",
  ],
  ["--pool", "worker", "--brief", " ", "--url", "http://127.0.0.1:12345/mcp"],
]) {
  it.effect(
    `rejects invalid run arguments before credential or file access: ${args.join(" ")}`,
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(Command.runWith(runCommand, { version: "test" })(args));
        assert.equal(result._tag, "Failure");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
}
