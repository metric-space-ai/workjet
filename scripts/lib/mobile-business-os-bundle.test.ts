import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { writeMobileBusinessOsBundle } from "./mobile-business-os-bundle.mjs";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mobile-bundle-" });
  const sourceRoot = path.join(root, "source");
  yield* fs.makeDirectory(path.join(sourceRoot, "vendor/ctox-office"), { recursive: true });
  for (const name of [
    "index.html",
    "mobile-host.js",
    "mobile-host.css",
    "vendor/ctox-office/office.js",
  ]) {
    yield* fs.writeFileString(
      path.join(sourceRoot, name),
      name === "index.html" ? "<html><head></head></html>" : name,
    );
  }
  return {
    fs,
    path,
    root,
    options: {
      sourceRoot,
      outputRoot: path.join(root, "bundle"),
      release: { version: "verified-test" },
      catalog: {
        type: "workjet.business-os-mobile-apps.v1",
        revision: "test",
        apps: [{ id: "threads", title: "Threads", icon: "bubble.left" }],
      },
    },
  };
});

const run = Effect.scoped;

it.layer(NodeServices.layer)("Business OS resources inside the signed mobile binary", (it) => {
  it.effect("includes the native catalog, preserves file hashes, and keeps Office separate", () =>
    run(
      Effect.gen(function* () {
        const { fs, path, options } = yield* fixture;
        const result = yield* Effect.tryPromise(() => writeMobileBusinessOsBundle(options));
        const payload = path.join(options.outputRoot, "payload");
        assert.deepEqual(
          result.files.map((file) => file.path),
          ["index.html", "mobile-apps.json", "mobile-host.css", "mobile-host.js"],
        );
        for (const file of result.files) {
          const bytes = yield* fs.readFile(path.join(payload, file.path));
          assert.equal(file.size, bytes.length);
          assert.equal(file.sha256, NodeCrypto.createHash("sha256").update(bytes).digest("hex"));
        }
        const catalog = yield* fs.readFileString(path.join(payload, "mobile-apps.json"));
        assert.deepEqual(JSON.parse(catalog).apps, [{ id: "threads", title: "Threads" }]);
        assert.isFalse(yield* fs.exists(path.join(payload, "vendor/ctox-office")));
        assert.match(result.packId, /^[0-9a-f]{64}$/u);
        const repeated = yield* Effect.tryPromise(() =>
          writeMobileBusinessOsBundle({ ...options, outputRoot: `${options.outputRoot}-again` }),
        );
        assert.equal(repeated.packId, result.packId);
      }),
    ),
  );

  it.effect(
    "refuses missing entry points instead of packaging a launcher that cannot open apps",
    () =>
      run(
        Effect.gen(function* () {
          const { fs, path, options } = yield* fixture;
          yield* fs.remove(path.join(options.sourceRoot, "mobile-host.js"));
          const message = yield* Effect.promise(() =>
            writeMobileBusinessOsBundle(options).then(
              () => "unexpected success",
              (error: unknown) => String(error),
            ),
          );
          assert.include(message, "Missing mobile shell entry: mobile-host.js");
        }),
      ),
  );

  it.effect("refuses links out of the verified source tree", () =>
    run(
      Effect.gen(function* () {
        const { fs, path, root, options } = yield* fixture;
        yield* fs.writeFileString(path.join(root, "private.txt"), "must not enter the bundle");
        yield* fs.symlink(
          path.join(root, "private.txt"),
          path.join(options.sourceRoot, "leak.txt"),
        );
        const message = yield* Effect.promise(() =>
          writeMobileBusinessOsBundle(options).then(
            () => "unexpected success",
            (error: unknown) => String(error),
          ),
        );
        assert.include(message, "symbolic link");
      }),
    ),
  );
});
