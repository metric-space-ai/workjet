// @effect-diagnostics nodeBuiltinImport:off -- Exercise the pinned SDK transport without accounts or model calls.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { query, type SDKUserMessage, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { spawnAdmittedClaudeProcess } from "./ClaudeNamespaceSpawn.ts";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const script = `const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "control_request")
    process.stdout.write(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success", request_id: request.request_id,
        response: {
          commands: [], models: [], agents: [],
          output_style: "default", available_output_styles: ["default"]
        }
      }
    }) + "\\n");
});
input.on("close", () => process.exit(0));`;

it.effect(
  "the actual SDK initializes through the waiting process handle and closes its owned child",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "wj-claude-sdk-" });
        const entry = NodePath.join(root, "cli.js");
        yield* fs.writeFileString(entry, script);
        yield* Effect.promise(async () => {
          const entered = deferred<void>();
          const gate = deferred<void>();
          const done = deferred<void>();
          const terminal = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
          let starts = 0;
          const errors: Error[] = [];
          async function* prompt(): AsyncIterable<SDKUserMessage> {
            await done.promise;
          }
          const runtime = query({
            prompt: prompt(),
            options: {
              cwd: root,
              env: { HOME: root, CLAUDE_CONFIG_DIR: root, PATH: process.env.PATH },
              pathToClaudeCodeExecutable: entry,
              executable: "node",
              settingSources: [],
              spawnClaudeCodeProcess: (input) => {
                const child = spawnAdmittedClaudeProcess(
                  input,
                  async (spawn: SpawnOptions) => {
                    entered.resolve();
                    await gate.promise;
                    spawn.signal.throwIfAborted();
                    return {
                      command: process.execPath,
                      args: spawn.args,
                      cwd: root,
                      env: spawn.env,
                    };
                  },
                  (spawn) => {
                    starts++;
                    return NodeChildProcess.spawn(spawn.command, spawn.args, {
                      cwd: spawn.cwd,
                      env: spawn.env,
                      signal: spawn.signal,
                      stdio: ["pipe", "pipe", "pipe"],
                    });
                  },
                );
                child.on("error", (error) => errors.push(error));
                child.once("exit", (code, signal) => terminal.resolve({ code, signal }));
                return child;
              },
            },
          });
          try {
            const initialization = runtime.initializationResult();
            await entered.promise;
            expect(starts).toBe(0);
            gate.resolve();
            const result = await initialization;
            expect(result.commands).toEqual([]);
            expect(result.models).toEqual([]);
            expect(starts).toBe(1);
          } finally {
            done.resolve();
            runtime.close();
            const exit = await terminal.promise;
            expect(exit.code === 0 || exit.signal === "SIGTERM").toBe(true);
            expect(errors.every((error) => error.name === "AbortError")).toBe(true);
          }
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
