import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ResourceMonitorBinary } from "../resourceTelemetry/ResourceMonitorBinary.ts";
import { make } from "./NativeWorkerWorktreeRemover.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-isolated-custody-" });
  const worker = path.join(root, "prepared");
  yield* fs.makeDirectory(path.join(worker, ".git/objects/info"), { recursive: true });
  const helper = path.join(root, "helper");
  yield* fs.writeFileString(
    helper,
    '#!/bin/sh\nset -e\nmv "$2" "$8"\nprintf \'%s\' \'{"status":"published"}\'\n',
  );
  yield* fs.chmod(helper, 0o700);
  const service = yield* make().pipe(
    Effect.provideService(ResourceMonitorBinary, { resolve: Effect.succeed(helper) }),
  );
  return { fs, path, root, worker, helper, service };
});

const provide = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Path.Path
    | import("effect/Scope").Scope
    | import("effect/unstable/process").ChildProcessSpawner.ChildProcessSpawner
  >,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("keeps default capture and removal closed to standalone repositories", () =>
  provide(
    Effect.gen(function* () {
      const { service, worker } = yield* fixture;
      expect((yield* service.capture(worker).pipe(Effect.flip)).reason).toBe("backlink");
      expect((yield* service.remove(worker).pipe(Effect.flip)).reason).toBe("backlink");
      const captured = yield* service.capture(worker, "isolated");
      expect(captured.kind).toBe("isolated");
      expect((yield* service.removeCaptured(captured).pipe(Effect.flip)).reason).toBe("backlink");
    }),
  ),
);

it.effect("retains original captured identities after publication", () =>
  provide(
    Effect.gen(function* () {
      const { service, path, root, worker } = yield* fixture;
      const captured = yield* service.capture(worker, "isolated");
      const destination = path.join(root, "published");
      const moved = yield* service.publishCaptured(captured, destination);
      expect(moved).toEqual({
        ...captured,
        worktreePath: destination,
        adminPath: path.join(destination, ".git"),
      });
      expect(captured.worktreePath).toBe(worker);
    }),
  ),
);

it.effect("rejects publication without isolated custody or outside the captured parent", () =>
  provide(
    Effect.gen(function* () {
      const { service, path, root, worker } = yield* fixture;
      const captured = yield* service.capture(worker, "isolated");
      const { kind, ...linkedCapture } = captured;
      expect(kind).toBe("isolated");
      expect(
        (yield* service
          .publishCaptured(linkedCapture, path.join(root, "published"))
          .pipe(Effect.flip)).reason,
      ).toBe("identity");
      expect(
        (yield* service
          .publishCaptured(captured, path.join(root, "other/published"))
          .pipe(Effect.flip)).reason,
      ).toBe("identity");
      expect(
        (yield* service
          .publishCaptured(
            { ...captured, adminPath: "/foreign/.git" },
            path.join(root, "published"),
          )
          .pipe(Effect.flip)).reason,
      ).toBe("identity");
    }),
  ),
);

it.effect("returns isolated recovery paths only after a native quarantine receipt", () =>
  provide(
    Effect.gen(function* () {
      const { service, path, fs, helper, worker } = yield* fixture;
      const captured = yield* service.capture(worker, "isolated");
      yield* fs.writeFileString(
        helper,
        '#!/bin/sh\nset -e\nmv "$2" "$2.workjet-rejected-$4"\nprintf \'%s\' \'{"status":"quarantined"}\'\n',
      );
      const recovery = yield* service.quarantineCaptured(captured, {
        headOid: "a".repeat(40),
        branchRef: "workjet/worker/one",
      });
      expect(recovery.recoveryAdminPath).toBe(path.join(recovery.recoveryWorktreePath, ".git"));
      expect(recovery.recoveryLocationStatus).toBe("verified");
      yield* fs.writeFileString(
        helper,
        "#!/bin/sh\nprintf '%s' '{\"status\":\"failed\"}'\nexit 1\n",
      );
      const error = yield* service
        .quarantineCaptured(captured, { headOid: "a".repeat(40), branchRef: "workjet/worker/one" })
        .pipe(Effect.flip);
      expect(error.recoveryLocationStatus).toBe("candidate");
      expect(error.recoveryAdminPath).toBe(
        path.join(recovery.recoveryWorktreePath ?? "missing", ".git"),
      );
    }),
  ),
);

it.effect("rejects a native publication response whose final path was replaced", () =>
  provide(
    Effect.gen(function* () {
      const { service, fs, path, helper, root, worker } = yield* fixture;
      const captured = yield* service.capture(worker, "isolated");
      const destination = path.join(root, "published");
      yield* fs.writeFileString(
        helper,
        '#!/bin/sh\nset -e\nmv "$2" "$8"\nmv "$8" "$8.original"\nmkdir -p "$8/.git"\nprintf \'%s\' \'{"status":"published"}\'\n',
      );
      expect((yield* service.publishCaptured(captured, destination).pipe(Effect.flip)).reason).toBe(
        "identity",
      );
      expect(yield* fs.exists(destination + ".original/.git")).toBe(true);
      expect(yield* fs.exists(destination + "/.git")).toBe(true);
    }),
  ),
);

it.effect("does not verify isolated recovery when the native helper moved a replacement", () =>
  provide(
    Effect.gen(function* () {
      const { service, fs, path, helper, worker } = yield* fixture;
      const captured = yield* service.capture(worker, "isolated");
      const recoveryPath = worker + ".workjet-rejected-" + captured.worktreeIno;
      yield* fs.writeFileString(
        helper,
        '#!/bin/sh\nset -e\nmv "$2" "$2.original"\nmkdir -p "$2.workjet-rejected-$4/.git"\nprintf \'%s\' \'{"status":"quarantined"}\'\n',
      );
      const error = yield* service
        .quarantineCaptured(captured, { headOid: "a".repeat(40), branchRef: "workjet/worker/one" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("identity");
      expect(error.recoveryLocationStatus).toBe("candidate");
      expect(yield* fs.exists(worker + ".original/.git")).toBe(true);
      expect(yield* fs.exists(path.join(recoveryPath, ".git"))).toBe(true);
    }),
  ),
);
