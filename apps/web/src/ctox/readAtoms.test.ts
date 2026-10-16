import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ConnectionTargetStore, EnvironmentCacheStore } from "@workjet/client-runtime/platform";
import { EnvironmentId } from "@workjet/contracts";
import { connectionStorageLayer } from "../connection/storage";
import { seedKernelTestShell } from "./kernelTestHost";
import { bindKernelCtoxClient } from "./kernelClient";
import { expect, it } from "vite-plus/test";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { createKernel } from "./kernel/kernel.mjs";
import { KernelTransport } from "./kernel/transport.mjs";
import { bindCtoxClient } from "./ctoxClient";
import { createCtoxReadAtomFamily } from "./readAtoms";
import { commitActiveWorkjetSelection, readActiveWorkjetScope } from "../activeWorkjetScope";

it("invalidates an atom from real kernel pages and disposes the old scope", async () => {
  const before = readActiveWorkjetScope().selectedInstanceId;
  const kernels = await Promise.all(
    ["a", "b"].map(async (id) => {
      const kernel = createKernel({
        instanceId: `atom-${id}`,
        userId: "owner",
        dbName: `p11c-atom-${id}`,
        storage: "memory",
        multiTab: false,
        transport: new KernelTransport(),
      });
      await kernel.ready;
      return kernel;
    }),
  );
  const releases = kernels.map((kernel) =>
    bindCtoxClient(kernel.instanceId, kernel.appApi("workjet", "test")),
  );
  const registry = AtomRegistry.make();
  const family = createCtoxReadAtomFamily<Record<string, never>, readonly string[]>({
    collections: ["workjet_projects"],
    read: (api) =>
      api
        .query<{ id: string }>("workjet_projects", {})
        .get()
        .map((row) => row.id),
  });
  const atom = family("{}");
  const off = registry.mount(atom);
  const read = () => {
    const result = registry.get(atom);
    return AsyncResult.isSuccess(result) ? result.value : null;
  };
  try {
    commitActiveWorkjetSelection("atom-a");
    expect(read()).toEqual([]);
    await kernels[0]!.receivePage({
      epoch: "1",
      collection: "workjet_projects",
      scope_hash: "local",
      gen: 1,
      cursor_to: "1",
      complete: true,
      docs: [{ id: "a-project", seq: "1", rev: "1", data: { id: "a-project" } }],
    });
    expect(read()).toEqual(["a-project"]);
    commitActiveWorkjetSelection("atom-b");
    expect(read()).toEqual([]);
    await kernels[0]!.receivePage({
      epoch: "1",
      collection: "workjet_projects",
      scope_hash: "local",
      gen: 1,
      cursor_to: "2",
      complete: true,
      docs: [{ id: "late-a", seq: "2", rev: "2", data: { id: "late-a" } }],
    });
    expect(read()).toEqual([]);
    releases[1]!();
    expect(read()).toBeNull();
  } finally {
    off();
    registry.dispose();
    releases.forEach((release) => release());
    commitActiveWorkjetSelection(before);
    await Promise.all(kernels.map((kernel) => kernel.close()));
  }
});

effectIt.effect("keeps the V4 host away from the legacy service catalog", () =>
  Effect.gen(function* () {
    const before = readActiveWorkjetScope().selectedInstanceId;
    const kernel = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const value = createKernel({
          instanceId: "storage-contract",
          userId: "owner",
          storage: "memory",
          dbName: "p11c-storage",
          multiTab: false,
          transport: new KernelTransport(),
        });
        await value.ready;
        await seedKernelTestShell(value);
        return value;
      }),
      (value) => Effect.promise(() => value.close()),
    );
    const unbind = bindKernelCtoxClient(kernel, "storage");
    commitActiveWorkjetSelection(kernel.instanceId);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unbind();
        commitActiveWorkjetSelection(before);
      }),
    );
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        const targets = yield* ConnectionTargetStore;
        expect(yield* targets.list).toEqual([]);
        const cache = yield* EnvironmentCacheStore;
        expect((yield* cache.loadShell(EnvironmentId.make("legacy")))._tag).toBe("None");
      }).pipe(Effect.provide(connectionStorageLayer)),
    );
    expect(result._tag).toBe("Success");
  }),
);
