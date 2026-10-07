import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { openSshReverseForward } from "./reverseForward.ts";

it.live(
  "binds only target loopback with registered SSH auth and closes with the source service scope",
  () => {
    let killed = 0;
    let verified = 0;
    let args: readonly string[] = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        args = command._tag === "StandardCommand" ? command.args : [];
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4242),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () =>
            Effect.sync(() => {
              killed++;
            }),
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    return Effect.gen(function* () {
      const forward = yield* Effect.scoped(
        openSshReverseForward(
          { alias: "registered-gpu3", hostname: "gpu3", username: "worker", port: 22 },
          { localPort: 40001, remotePort: 40002 },
          {
            probe: () =>
              Effect.sync(() => {
                verified++;
                return true;
              }),
          },
        ),
      );
      assert.equal(killed, 1);
      yield* forward.close;
      assert.equal(killed, 1);
      assert.equal(verified, 1);
      assert.include(args, "-R");
      assert.include(args, "127.0.0.1:40002:127.0.0.1:40001");
      assert.include(args, "BatchMode=yes");
      assert.include(args, "ExitOnForwardFailure=yes");
      assert.isFalse(args.some((arg) => arg.includes("StrictHostKeyChecking")));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  },
);

it.live("rejects invalid reverse ports before a process is spawned", () => {
  let spawned = false;
  const spawner = ChildProcessSpawner.make(() => {
    spawned = true;
    return Effect.never;
  });
  return Effect.gen(function* () {
    const error = yield* openSshReverseForward(
      { alias: "gpu3", hostname: "gpu3", username: "worker", port: 22 },
      { localPort: 0, remotePort: 40002 },
      { probe: () => Effect.succeed(true) },
    ).pipe(Effect.flip);
    assert.equal(error.reason, "invalid_port");
    assert.isFalse(spawned);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
  );
});
