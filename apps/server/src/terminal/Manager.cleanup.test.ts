import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  { excludeTestServices: true },
)("Terminal cleanup with a real PTY", (it) => {
  it.effect("returns only after the owned process makes its final write and exits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-terminal-exit-" });
      const executable = path.join(root, "terminal-fixture");
      yield* fs.writeFileString(
        executable,
        `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => {
  fs.writeFileSync(process.env.HOME + '/last-write', 'written before exit');
  process.exit(0);
});
setInterval(() => {}, 1000);
process.stdout.write('workjet-terminal-ready\\n');
`,
      );
      yield* fs.chmod(executable, 0o700);
      const adapter = yield* NodePtyAdapter.make();
      const scope = yield* Scope.Scope;
      const exited = yield* Deferred.make<void>();
      let exitObserved = false;
      const manager = yield* TerminalManager.makeWithOptions({
        logsDir: path.join(root, "logs"),
        shellResolver: () => executable,
        env: { HOME: root, PATH: "/usr/bin:/bin", TMPDIR: root },
        processKillGraceMs: 1_000,
        subprocessInspector: () =>
          Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
        ptyAdapter: {
          spawn: (input) =>
            adapter.spawn(input).pipe(
              Effect.map(
                (owned): PtyAdapter.PtyProcess => ({
                  pid: owned.pid,
                  write: (data) => owned.write(data),
                  resize: (cols, rows) => owned.resize(cols, rows),
                  kill: (signal) => owned.kill(signal),
                  onData: (listener) => owned.onData(listener),
                  // Observe the OS event before forwarding it to any subscriber;
                  // subscriber scheduling order is not a process-liveness signal.
                  onExit: (listener) =>
                    owned.onExit((event) => {
                      exitObserved = true;
                      listener(event);
                    }),
                }),
              ),
              Effect.tap((owned) =>
                Effect.gen(function* () {
                  yield* Effect.callback<void>((resume) => {
                    const unsubscribe = owned.onExit(() => {
                      resume(Effect.void);
                    });
                    return Effect.sync(unsubscribe);
                  }).pipe(
                    Effect.tap(() => Deferred.succeed(exited, undefined)),
                    Effect.forkIn(scope),
                  );
                  yield* Effect.logInfo("terminal cleanup fixture spawned", { pid: owned.pid });
                  // This captured fixture process must be reaped even if readiness/assertions fail.
                  yield* Scope.addFinalizer(
                    scope,
                    Effect.gen(function* () {
                      if (!exitObserved) {
                        yield* Effect.sync(() => owned.kill("SIGKILL"));
                      }
                      yield* Deferred.await(exited).pipe(Effect.timeout("5 seconds"), Effect.orDie);
                      yield* Effect.logInfo("terminal cleanup fixture reaped", { pid: owned.pid });
                    }),
                  );
                }),
              ),
            ),
        },
      });
      const ready = yield* Deferred.make<void>();
      let output = "";
      yield* manager.subscribe((event) => {
        if (event.type !== "output") return Effect.void;
        output += event.data;
        return output.includes("workjet-terminal-ready")
          ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
          : Effect.void;
      });
      yield* manager.open({ threadId: "owned-fixture", terminalId: "default", cwd: root });
      yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"));
      assert.isTrue(yield* manager.closeForCleanup({ threadId: "owned-fixture" }));
      assert.isTrue(exitObserved);
      assert.equal(yield* fs.readFileString(path.join(root, "last-write")), "written before exit");
    }),
  );
});
