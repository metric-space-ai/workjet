// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The shell fixture owns a real backend stand-in process and a temporary HOME.
import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import {
  buildRemoteUpdateScript,
  parseRemoteUpdateOutput,
  REMOTE_UPDATE_RECHECK_INTERVAL,
  type RemoteUpdateCheck,
  type RemoteUpdatePhase,
  type RemoteUpdateStop,
  runRemoteServerUpdate,
} from "./remoteUpdate.ts";
import { buildRemoteLaunchScript } from "./tunnel.ts";

const fakeOperations = (input: {
  readonly checks: ReadonlyArray<RemoteUpdateCheck>;
  readonly stop?: RemoteUpdateStop;
  readonly restartFails?: boolean;
}) => {
  const calls: string[] = [];
  const reports: RemoteUpdatePhase[] = [];
  let checkIndex = 0;
  return {
    calls,
    reports,
    operations: {
      check: Effect.sync(() => {
        calls.push("check");
        return input.checks[Math.min(checkIndex++, input.checks.length - 1)]!;
      }),
      stop: Effect.sync(() => {
        calls.push("stop");
        return input.stop ?? "stopped";
      }),
      restart: input.restartFails
        ? Effect.sync(() => calls.push("restart")).pipe(Effect.andThen(Effect.fail("boom")))
        : Effect.sync(() => {
            calls.push("restart");
          }),
      report: (phase: RemoteUpdatePhase) => Effect.sync(() => reports.push(phase)),
    },
  };
};

describe("idle-gated remote backend update", () => {
  it.effect("outdated and idle: stops, restarts and reports the orange phase around it", () =>
    Effect.gen(function* () {
      const fake = fakeOperations({ checks: ["idle"] });
      const outcome = yield* runRemoteServerUpdate(fake.operations);
      assert.equal(outcome, "updated");
      assert.deepEqual(fake.calls, ["check", "stop", "restart"]);
      assert.deepEqual(fake.reports, ["updating", "updated"]);
    }),
  );

  it.effect("outdated with a running turn: deferred, no stop, re-checked after the interval", () =>
    Effect.gen(function* () {
      const fake = fakeOperations({ checks: ["busy", "busy", "idle"] });
      const fiber = yield* runRemoteServerUpdate(fake.operations).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepEqual(fake.calls, ["check"]);
      assert.deepEqual(fake.reports, []);
      yield* TestClock.adjust(REMOTE_UPDATE_RECHECK_INTERVAL);
      assert.deepEqual(fake.calls, ["check", "check"]);
      assert.deepEqual(fake.reports, []);
      yield* TestClock.adjust(REMOTE_UPDATE_RECHECK_INTERVAL);
      assert.equal(yield* Fiber.join(fiber), "updated");
      assert.deepEqual(fake.calls, ["check", "check", "check", "stop", "restart"]);
    }),
  );

  it.effect("current backend: nothing happens", () =>
    Effect.gen(function* () {
      const fake = fakeOperations({ checks: ["current"] });
      assert.equal(yield* runRemoteServerUpdate(fake.operations), "current");
      assert.deepEqual(fake.calls, ["check"]);
      assert.deepEqual(fake.reports, []);
    }),
  );

  it.effect("failed restart: reports update-failed for the row", () =>
    Effect.gen(function* () {
      const fake = fakeOperations({ checks: ["idle"], restartFails: true });
      const exit = yield* Effect.exit(runRemoteServerUpdate(fake.operations));
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(fake.reports, ["updating", "update-failed"]);
    }),
  );

  it("parses only known update states", () => {
    assert.equal(parseRemoteUpdateOutput('motd\n{"update":"busy"}\n'), "busy");
    assert.equal(parseRemoteUpdateOutput('{"update":"exploded"}'), null);
    assert.equal(parseRemoteUpdateOutput(""), null);
  });
});

describe("remote update shell scripts", () => {
  const spawnBackend = async (scriptPath: string) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        'require("node:http").createServer((_q, r) => r.end("ok")).listen(0, "127.0.0.1", function () { console.log(this.address().port); });',
        scriptPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("backend did not start")), 5_000);
      child.once("error", reject);
      child.stdout!.once("data", (chunk: Buffer) => {
        clearTimeout(timeout);
        resolve(Number(String(chunk).trim()));
      });
    });
    return { child, port };
  };

  const withHome = async (
    run: (input: {
      home: string;
      state: string;
      child: NodeChildProcess.ChildProcess;
      port: number;
      oldScript: string;
    }) => Promise<void>,
  ) => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-ssh-update-"));
    const oldScript = NodePath.join(home, ".workjet/ssh-server/olddigest/package/dist/bin.mjs");
    const { child, port } = await spawnBackend(oldScript);
    try {
      const state = NodePath.join(home, ".workjet", "ssh-launch", "profile-a");
      await NodeFSP.mkdir(state, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(state, "pid"), `${child.pid}\n`);
      await NodeFSP.writeFile(NodePath.join(state, "port"), `${port}\n`);
      await NodeFSP.writeFile(NodePath.join(state, "managed"), "managed\n");
      await run({ home, state, child, port, oldScript });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  };

  const runUpdate = (home: string, mode: "check" | "stop", expected: string) => {
    const result = NodeChildProcess.spawnSync("sh", ["-s", "--", "profile-a", mode], {
      input: buildRemoteUpdateScript(expected),
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      timeout: 40_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return parseRemoteUpdateOutput(result.stdout);
  };

  const writeActivity = (state: string, idle: boolean) =>
    NodeFSP.writeFile(
      NodePath.join(state, "run-workjet.sh"),
      `#!/bin/sh\n[ "$1" = "__activity" ] && printf '{"idle":${idle},"activeSessions":${idle ? 0 : 1}}\\n'\n`,
      { mode: 0o700 },
    );

  it("launch reports an outdated own backend and stays quiet for a current one", async () => {
    await withHome(async ({ home, port, oldScript }) => {
      const attach = (nodeScriptPath: string) => {
        const result = NodeChildProcess.spawnSync("sh", ["-s", "--", "profile-a"], {
          input: buildRemoteLaunchScript({ nodeScriptPath }),
          encoding: "utf8",
          env: { ...process.env, HOME: home },
          timeout: 10_000,
        });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
      };
      assert.deepEqual(attach(oldScript), { remotePort: port, serverKind: "managed" });
      assert.deepEqual(attach(NodePath.join(home, ".workjet/ssh-server/newdigest/bin.mjs")), {
        remotePort: port,
        serverKind: "managed",
        outdated: true,
      });
    });
  });

  it("busy backend: check and stop both answer busy and nothing is stopped", async () => {
    await withHome(async ({ home, state, child }) => {
      await writeActivity(state, false);
      const expected = NodePath.join(home, ".workjet/ssh-server/newdigest/bin.mjs");
      assert.equal(runUpdate(home, "check", expected), "busy");
      assert.equal(runUpdate(home, "stop", expected), "busy");
      assert.doesNotThrow(() => process.kill(child.pid!, 0));
      assert.equal(
        (await NodeFSP.readFile(NodePath.join(state, "managed"), "utf8")).trim(),
        "managed",
      );
    });
  });

  it("idle outdated backend: stop terminates only it and keeps the port for the restart", async () => {
    await withHome(async ({ home, state, child, port }) => {
      await writeActivity(state, true);
      const expected = NodePath.join(home, ".workjet/ssh-server/newdigest/bin.mjs");
      assert.equal(runUpdate(home, "check", expected), "idle");
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      assert.equal(runUpdate(home, "stop", expected), "stopped");
      await exited;
      assert.equal(
        (await NodeFSP.readFile(NodePath.join(state, "port"), "utf8")).trim(),
        String(port),
      );
      const pidKept = await NodeFSP.access(NodePath.join(state, "pid")).then(
        () => true,
        () => false,
      );
      assert.isFalse(pidKept);
    });
  });

  it("current backend: the update script reports current without asking for activity", async () => {
    await withHome(async ({ home, child, oldScript }) => {
      assert.equal(runUpdate(home, "stop", oldScript), "current");
      assert.doesNotThrow(() => process.kill(child.pid!, 0));
    });
  });
});
