// @effect-diagnostics nodeBuiltinImport:off -- Real Linux directory descriptors exercise profile substitution.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { afterEach, expect } from "vite-plus/test";
import { HostProcessEnvironment, HostProcessPlatform } from "@workjet/shared/hostProcess";
import { makeWorkerSourcePrivateProfile } from "./WorkerSourcePrivateProfile.ts";
import { workerSourceNativeProfile } from "./WorkerSourceNativeProfile.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const create = (directory: string) =>
  workerSourceNativeProfile({
    harness: "minimax-code",
    model: "gpt-6.1-sol",
    directory,
    baseUrl: "http://127.0.0.1:23197/v1",
    apiKey: "scoped-profile-fixture",
  });
const baseDirectory = Effect.gen(function* () {
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const base = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(
      NodePath.join(
        environment.TMPDIR ?? (platform === "darwin" ? "/Volumes/tmp" : NodeOS.tmpdir()),
        "private-profile-",
      ),
    ),
  );
  cleanups.push(() => NodeFSP.rm(base, { recursive: true, force: true }));
  return { base, platform };
});

it.effect("captures a fresh private profile without adopting an existing config", () =>
  Effect.gen(function* () {
    const { base, platform } = yield* baseDirectory;
    const root = NodePath.join(base, "profiles");
    if (platform !== "linux") {
      yield* Effect.promise(() =>
        expect(makeWorkerSourcePrivateProfile(root, create)).rejects.toThrow("custody"),
      );
      return;
    }
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(root, { mode: 0o700 });
      await NodeFSP.writeFile(NodePath.join(root, "config.yaml"), "old config");
      const prepared = await makeWorkerSourcePrivateProfile(root, create);
      cleanups.push(prepared.close);
      expect(NodePath.dirname(prepared.profile.directory)).toBe(root);
      const original = await NodeFSP.lstat(prepared.profile.directory, { bigint: true });
      expect(prepared.capture).toEqual({
        path: prepared.profile.directory,
        identity: { device: String(original.dev), inode: String(original.ino) },
      });
      expect(original.mode & 0o077n).toBe(0n);
      expect(await NodeFSP.readFile(NodePath.join(root, "config.yaml"), "utf8")).toBe("old config");
      expect(
        await NodeFSP.readFile(NodePath.join(prepared.profile.directory, "config.yaml"), "utf8"),
      ).toContain("scoped-profile-fixture");

      await prepared.verify();
      await prepared.close();
      await prepared.close();
      await expect(prepared.verify()).rejects.toThrow("custody");
    });
  }),
);

for (const target of ["root", "profile"] as const) {
  it.effect(
    `keeps initialization on the original descriptor when the ${target} path is replaced`,
    () =>
      Effect.gen(function* () {
        const { base, platform } = yield* baseDirectory;
        if (platform !== "linux") return;
        yield* Effect.promise(async () => {
          const root = NodePath.join(base, "profiles");
          let originalDirectory = "";
          let replacementDirectory = "";
          await expect(
            makeWorkerSourcePrivateProfile(root, (directory) => {
              const swapped = target === "root" ? root : directory;
              const moved = swapped + "-held";
              NodeFS.renameSync(swapped, moved);
              NodeFS.mkdirSync(swapped, { mode: 0o700 });
              originalDirectory =
                target === "root" ? NodePath.join(moved, NodePath.basename(directory)) : moved;
              replacementDirectory =
                target === "root" ? NodePath.join(root, NodePath.basename(directory)) : directory;
              return create(directory);
            }),
          ).rejects.toThrow("custody");
          expect(
            await NodeFSP.readFile(NodePath.join(originalDirectory, "config.yaml"), "utf8"),
          ).toContain("scoped-profile-fixture");
          expect(
            await NodeFSP.lstat(NodePath.join(replacementDirectory, "config.yaml")).catch(
              () => undefined,
            ),
          ).toBeUndefined();
        });
      }),
  );
}

it.effect("rejects a symlinked root and revoked private-directory permissions", () =>
  Effect.gen(function* () {
    const { base, platform } = yield* baseDirectory;
    if (platform !== "linux") return;
    yield* Effect.promise(async () => {
      const root = NodePath.join(base, "profiles");
      await NodeFSP.mkdir(root, { mode: 0o700 });
      const alias = NodePath.join(base, "alias");
      await NodeFSP.symlink(root, alias);
      let created = false;
      await expect(
        makeWorkerSourcePrivateProfile(alias, (directory) => {
          created = true;
          return create(directory);
        }),
      ).rejects.toThrow("custody");
      expect(created).toBe(false);
      const prepared = await makeWorkerSourcePrivateProfile(root, create);
      cleanups.push(prepared.close);
      await NodeFSP.chmod(prepared.profile.directory, 0o777);
      await expect(prepared.verify()).rejects.toThrow("custody");
      await NodeFSP.chmod(prepared.profile.directory, 0o700);
      await prepared.verify();
      await NodeFSP.rename(prepared.profile.directory, prepared.profile.directory + "-held");
      await NodeFSP.mkdir(prepared.profile.directory, { mode: 0o700 });
      await expect(prepared.verify()).rejects.toThrow("custody");
    });
  }),
);

for (const target of ["root", "profile", "home"] as const) {
  it.effect(`does not recover or write scoped config through a replaced ${target}`, () =>
    Effect.gen(function* () {
      const { base, platform } = yield* baseDirectory;
      if (platform !== "linux") return;
      yield* Effect.promise(async () => {
        const root = NodePath.join(base, "profiles");
        const first = await makeWorkerSourcePrivateProfile(root, create);
        const original = first.custody;
        const directory = first.profile.directory;
        await first.close();
        const swapped =
          target === "root"
            ? root
            : target === "profile"
              ? directory
              : NodePath.join(directory, "home");
        await NodeFSP.rename(swapped, swapped + "-held");
        if (target === "home") {
          const foreign = NodePath.join(base, "foreign-home");
          await NodeFSP.mkdir(foreign, { mode: 0o700 });
          await NodeFSP.symlink(foreign, swapped);
        } else {
          await NodeFSP.mkdir(swapped, { mode: 0o700 });
        }
        const replacedProfile =
          target === "root" ? NodePath.join(root, NodePath.basename(directory)) : directory;
        if (target === "root") await NodeFSP.mkdir(replacedProfile, { mode: 0o700 });
        const marker = NodePath.join(replacedProfile, "config.yaml");
        await NodeFSP.writeFile(marker, "replacement must stay unchanged");
        await expect(
          makeWorkerSourcePrivateProfile(root, create, {
            original,
            capture: async () => {},
          }),
        ).rejects.toThrow();
        expect(await NodeFSP.readFile(marker, "utf8")).toBe("replacement must stay unchanged");
        if (target === "home")
          expect(await NodeFSP.readdir(NodePath.join(base, "foreign-home"))).toEqual([]);
      });
    }),
  );
}

it.effect(
  "persists custody before publishing a scoped key and can recover interrupted initialization",
  () =>
    Effect.gen(function* () {
      const { base, platform } = yield* baseDirectory;
      if (platform !== "linux") return;
      yield* Effect.promise(async () => {
        const root = NodePath.join(base, "profiles");
        let captured:
          | Awaited<ReturnType<typeof makeWorkerSourcePrivateProfile>>["custody"]
          | undefined;
        await expect(
          makeWorkerSourcePrivateProfile(root, create, {
            original: null,
            capture: async (custody) => {
              captured = custody;
              expect(await NodeFSP.readdir(custody.profile.path)).toEqual([]);
              throw new Error("interrupted after persisted capture");
            },
          }),
        ).rejects.toThrow("interrupted");
        expect(captured).toBeDefined();
        const recovered = await makeWorkerSourcePrivateProfile(root, create, {
          original: captured!,
          capture: async (custody) => expect(custody).toEqual(captured),
        });
        cleanups.push(recovered.close);
        expect(recovered.capture).toEqual(captured!.profile);
        expect(
          await NodeFSP.readFile(NodePath.join(recovered.profile.directory, "config.yaml"), "utf8"),
        ).toContain("scoped-profile-fixture");
      });
    }),
);

it.effect("a missing journal capture cannot adopt or supersede an old profile", () =>
  Effect.gen(function* () {
    const { base, platform } = yield* baseDirectory;
    if (platform !== "linux") return;
    yield* Effect.promise(async () => {
      const root = NodePath.join(base, "profiles");
      const previous = await makeWorkerSourcePrivateProfile(root, create);
      const directory = previous.profile.directory;
      await previous.close();
      let recorded = false;
      await expect(
        makeWorkerSourcePrivateProfile(root, create, {
          original: null,
          capture: async () => {
            recorded = true;
          },
        }),
      ).rejects.toThrow("custody");
      expect(recorded).toBe(false);
      expect(await NodeFSP.readdir(root)).toEqual([NodePath.basename(directory)]);
      expect(await NodeFSP.readFile(NodePath.join(directory, "config.yaml"), "utf8")).toContain(
        "scoped-profile-fixture",
      );
    });
  }),
);
