import {
  GREPPY_MODEL_ASSETS,
  GREPPY_RUNTIME_PIN,
  WORKJET_GREPPY_EXECUTABLE_ENV,
} from "@metric-space-ai/workjet-capabilities";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  __testing,
  greppyModelUrl,
  GreppyRuntimeError,
  isAllowedGreppyDownloadUrl,
  isConfinedGreppyAssetPath,
  make,
  type GreppyRuntimePlatform,
  type RuntimeCommand,
  type RuntimeCommandResult,
  type RuntimeDownloadResult,
  toWorkjetGreppyOperationError,
  validateGreppyArchiveEntries,
} from "./GreppyRuntime.ts";

const encoder = new TextEncoder();
const completeSentinel = `${GREPPY_RUNTIME_PIN.version}\n${GREPPY_RUNTIME_PIN.sourceSha256}\n`;
const versionResult = result({ stdout: `greppy ${GREPPY_RUNTIME_PIN.version}\n` });
const searchHelpResult = result({ stdout: "--root --json --limit --max-bytes" });
const indexHelpResult = result({ stdout: "status --json --root" });

function result(input?: Partial<RuntimeCommandResult>): RuntimeCommandResult {
  const stdout = input?.stdout ?? "";
  return {
    exitCode: 0,
    stdout,
    stdoutBytes: encoder.encode(stdout).length,
    stderrBytes: 0,
    timedOut: false,
    outputExceeded: false,
    ...input,
  };
}

const healthyStatus = (overrides?: Record<string, unknown>) =>
  JSON.stringify({
    command: "index-status",
    status: "ok",
    healthy: true,
    store_exists: true,
    background_state: null,
    embedding_complete: true,
    fresh: true,
    schema_current: true,
    integrity_ok: true,
    project_present: true,
    ...overrides,
  });

const noIndexStatus = healthyStatus({
  status: "no_index",
  healthy: false,
  store_exists: false,
  embedding_complete: false,
  fresh: false,
  schema_current: false,
  integrity_ok: false,
  project_present: false,
});

interface FakeRuntime {
  readonly platform: GreppyRuntimePlatform;
  readonly files: Map<string, string>;
  readonly executables: Set<string>;
  readonly commands: Array<RuntimeCommand>;
  readonly downloads: Array<{
    readonly url: string;
    readonly destination: string;
    readonly policy: "source" | "model";
    readonly maximumBytes: number;
  }>;
  readonly removed: Array<string>;
  readonly tempParents: Array<string>;
  readonly renames: Array<{ readonly from: string; readonly to: string }>;
}

function fakeRuntime(input?: {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  readonly arch?: string;
  readonly run?: (
    command: RuntimeCommand,
    index: number,
    fake: FakeRuntime,
  ) => Promise<RuntimeCommandResult>;
  readonly download?: (
    request: {
      readonly url: string;
      readonly destination: string;
      readonly maximumBytes: number;
      readonly timeoutMs: number;
      readonly policy: "source" | "model";
    },
    index: number,
    fake: FakeRuntime,
  ) => Promise<RuntimeDownloadResult>;
}): FakeRuntime {
  const files = new Map<string, string>();
  const executables = new Set<string>();
  const commands: Array<RuntimeCommand> = [];
  const downloads: FakeRuntime["downloads"] = [];
  const removed: Array<string> = [];
  const tempParents: Array<string> = [];
  const renames: FakeRuntime["renames"] = [];
  let tempId = 0;
  const fake = {} as FakeRuntime;
  const platform: GreppyRuntimePlatform = {
    platform: input?.platform ?? "darwin",
    arch: input?.arch ?? "arm64",
    environment: input?.environment ?? {},
    temporaryDirectory: "/safe/os/tmp",
    statExecutable: async (path) => executables.has(path),
    realpath: async (path) => `/canonical${path}`,
    exists: async (path) =>
      files.has(path) ||
      executables.has(path) ||
      [...files.keys(), ...executables].some((entry) => entry.startsWith(`${path}/`)),
    mkdir: async () => undefined,
    makeTempDirectory: async (parent, prefix) => {
      tempParents.push(parent);
      tempId += 1;
      return `${parent}/${prefix}${tempId}`;
    },
    readText: async (path, maximumBytes) => {
      const content = files.get(path);
      if (content === undefined || encoder.encode(content).length > maximumBytes) {
        throw new Error("unreadable fake file");
      }
      return content;
    },
    writeText: async (path, content) => {
      if (files.has(path)) throw new Error("exclusive fake write failed");
      files.set(path, content);
    },
    remove: async (path) => {
      removed.push(path);
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      }
      for (const key of [...executables]) {
        if (key === path || key.startsWith(`${path}/`)) executables.delete(key);
      }
    },
    rename: async (from, to) => {
      renames.push({ from, to });
      for (const [key, value] of [...files]) {
        if (key === from || key.startsWith(`${from}/`)) {
          files.delete(key);
          files.set(`${to}${key.slice(from.length)}`, value);
        }
      }
      for (const key of [...executables]) {
        if (key === from || key.startsWith(`${from}/`)) {
          executables.delete(key);
          executables.add(`${to}${key.slice(from.length)}`);
        }
      }
    },
    copyFile: async (from, to) => {
      if (!executables.has(from) && !files.has(from)) throw new Error("missing copy source");
      files.set(to, files.get(from) ?? "fake executable");
    },
    chmodExecutable: async (path) => {
      if (!files.has(path)) throw new Error("missing chmod file");
      executables.add(path);
    },
    run: async (command) => {
      commands.push(command);
      if (input?.run) return input.run(command, commands.length - 1, fake);
      if (command.args[0] === "--version") return versionResult;
      if (command.args[0] === "search" && command.args[1] === "--help") return searchHelpResult;
      if (command.args[0] === "index" && command.args[1] === "--help") return indexHelpResult;
      return result();
    },
    download: async (request) => {
      downloads.push(request);
      if (input?.download) return input.download(request, downloads.length - 1, fake);
      files.set(request.destination, "downloaded");
      if (request.policy === "source") {
        return {
          sha256: GREPPY_RUNTIME_PIN.sourceSha256,
          bytes: 1_000,
          finalUrl:
            "https://codeload.github.com/metric-space-ai/greppy/tar.gz/de078b47d1df5df7c086e4591162517328f979ec",
          redirects: [
            "https://codeload.github.com/metric-space-ai/greppy/tar.gz/de078b47d1df5df7c086e4591162517328f979ec",
          ],
        };
      }
      const asset = GREPPY_MODEL_ASSETS.find(
        (candidate) =>
          request.url.includes(`/${candidate.repository}/`) &&
          request.url.endsWith(`/${candidate.file}`),
      );
      if (!asset) throw new Error("undeclared model request");
      return {
        sha256: asset.sha256,
        bytes: 10_000,
        finalUrl: request.url,
        redirects: [],
      };
    },
  };
  Object.assign(fake, {
    platform,
    files,
    executables,
    commands,
    downloads,
    removed,
    tempParents,
    renames,
  });
  return fake;
}

function installRun(command: RuntimeCommand, _index: number, fake: FakeRuntime) {
  if (command.args[0] === "--version") return Promise.resolve(versionResult);
  if (command.args[0] === "search" && command.args[1] === "--help") {
    return Promise.resolve(searchHelpResult);
  }
  if (command.args[0] === "index" && command.args[1] === "--help") {
    return Promise.resolve(indexHelpResult);
  }
  if (command.executable === "tar" && command.args[0] === "-tzf") {
    return Promise.resolve(
      result({
        stdout: [
          GREPPY_RUNTIME_PIN.archivePrefix,
          `${GREPPY_RUNTIME_PIN.archivePrefix}Cargo.lock`,
          `${GREPPY_RUNTIME_PIN.archivePrefix}${GREPPY_RUNTIME_PIN.modelManifestPath}`,
        ].join("\n"),
      }),
    );
  }
  if (command.executable === "tar" && command.args[0] === "-xzf") {
    const root = `${command.args[3]}/${GREPPY_RUNTIME_PIN.archivePrefix.slice(0, -1)}`;
    fake.files.set(
      `${root}/${GREPPY_RUNTIME_PIN.modelManifestPath}`,
      JSON.stringify({
        hf_host: "https://huggingface.co",
        revision: "main",
        assets: GREPPY_MODEL_ASSETS.map((asset) => ({
          hf_repo: asset.repository,
          hf_file: asset.file,
          dest: asset.destination,
          sha256: asset.sha256,
          revision: asset.revision,
        })),
      }),
    );
    return Promise.resolve(result());
  }
  if (command.executable === "cargo") {
    fake.executables.add(`${command.cwd}/${GREPPY_RUNTIME_PIN.binaryRelativePath}`);
    return Promise.resolve(result());
  }
  return Promise.resolve(result());
}

function successfulDownloadResult(request: {
  readonly url: string;
  readonly policy: "source" | "model";
}): RuntimeDownloadResult {
  if (request.policy === "source") {
    return {
      sha256: GREPPY_RUNTIME_PIN.sourceSha256,
      bytes: 1_000,
      finalUrl:
        "https://codeload.github.com/metric-space-ai/greppy/tar.gz/de078b47d1df5df7c086e4591162517328f979ec",
      redirects: [],
    };
  }
  const asset = GREPPY_MODEL_ASSETS.find(
    (candidate) =>
      request.url.includes(`/${candidate.repository}/`) &&
      request.url.endsWith(`/${candidate.file}`),
  );
  if (!asset) throw new Error("undeclared model request");
  return { sha256: asset.sha256, bytes: 10_000, finalUrl: request.url, redirects: [] };
}

function seedValidExecutable(fake: FakeRuntime, path: string): void {
  fake.executables.add(path);
}

function seedManaged(fake: FakeRuntime, stateDir: string): string {
  const paths = __testing.runtimePaths(stateDir);
  seedValidExecutable(fake, paths.executable);
  fake.files.set(paths.sentinel, completeSentinel);
  return paths.executable;
}

describe("GreppyRuntime resolution", () => {
  it.effect("uses override, managed, then PATH precedence", () =>
    Effect.gen(function* () {
      const overrideFake = fakeRuntime({
        environment: {
          [WORKJET_GREPPY_EXECUTABLE_ENV]: "/override/greppy",
          PATH: "/path/bin",
        },
      });
      seedValidExecutable(overrideFake, "/override/greppy");
      seedValidExecutable(overrideFake, "/path/bin/greppy");
      seedManaged(overrideFake, "/state");
      assert.equal(
        (yield* make({ stateDir: "/state", platform: overrideFake.platform }).resolve()).source,
        "override",
      );

      const managedFake = fakeRuntime({ environment: { PATH: "/path/bin" } });
      seedValidExecutable(managedFake, "/path/bin/greppy");
      seedManaged(managedFake, "/state");
      assert.equal(
        (yield* make({ stateDir: "/state", platform: managedFake.platform }).resolve()).source,
        "managed",
      );

      const pathFake = fakeRuntime({ environment: { PATH: "/path/bin" } });
      seedValidExecutable(pathFake, "/path/bin/greppy");
      const resolved = yield* make({ stateDir: "/state", platform: pathFake.platform }).resolve();
      assert.equal(resolved.source, "path");
      assert.equal(resolved.executable, "/path/bin/greppy");
    }),
  );

  it.effect("fails closed for a broken override without exposing its path or falling through", () =>
    Effect.gen(function* () {
      const secret = "/private/SENSITIVE_OVERRIDE/greppy";
      const fake = fakeRuntime({
        environment: { [WORKJET_GREPPY_EXECUTABLE_ENV]: secret, PATH: "/path/bin" },
      });
      seedValidExecutable(fake, "/path/bin/greppy");
      const runtime = make({ stateDir: "/state", platform: fake.platform });
      const error = yield* runtime.resolve().pipe(Effect.flip);
      assert.equal(error.reason, "override-invalid");
      assert.notInclude(error.message, secret);
      assert.equal(fake.commands.length, 0);
      const snapshot = yield* runtime.inspect();
      assert.deepEqual(snapshot, {
        availability: "unavailable",
        reason: "override-invalid",
        version: "0.3.1",
        installSupported: true,
      });
      assert.notInclude(JSON.stringify(snapshot), secret);

      const installError = yield* runtime.install().pipe(Effect.flip);
      assert.equal(installError.reason, "override-invalid");
      assert.notInclude(installError.message, secret);
    }),
  );

  it.effect("reports managed corruption unless a valid PATH fallback exists", () =>
    Effect.gen(function* () {
      const stateDir = "/state";
      const paths = __testing.runtimePaths(stateDir);
      const damaged = fakeRuntime({
        run: async (command) =>
          command.executable === paths.executable && command.args[0] === "--version"
            ? result({ stdout: "greppy 0.2.0\n" })
            : command.args[0] === "--version"
              ? versionResult
              : command.args[0] === "search"
                ? searchHelpResult
                : indexHelpResult,
      });
      seedManaged(damaged, stateDir);

      assert.deepEqual(yield* make({ stateDir, platform: damaged.platform }).inspect(), {
        availability: "unavailable",
        reason: "managed-invalid",
        version: "0.3.1",
        installSupported: true,
      });

      const missingBinary = fakeRuntime();
      missingBinary.files.set(paths.sentinel, completeSentinel);
      assert.deepEqual(yield* make({ stateDir, platform: missingBinary.platform }).inspect(), {
        availability: "unavailable",
        reason: "managed-invalid",
        version: "0.3.1",
        installSupported: true,
      });

      const fallback = fakeRuntime({
        environment: { PATH: "/path/bin" },
        run: async (command) =>
          command.executable === paths.executable && command.args[0] === "--version"
            ? result({ stdout: "greppy 0.2.0\n" })
            : command.args[0] === "--version"
              ? versionResult
              : command.args[0] === "search"
                ? searchHelpResult
                : indexHelpResult,
      });
      seedManaged(fallback, stateDir);
      seedValidExecutable(fallback, "/path/bin/greppy");
      assert.deepEqual(yield* make({ stateDir, platform: fallback.platform }).inspect(), {
        availability: "available",
        source: "path",
        version: "0.3.1",
        installSupported: true,
      });
    }),
  );

  it("maps internal failures to reason-only public errors", () => {
    const internal = Object.assign(new GreppyRuntimeError({ reason: "install-failed" }), {
      stdout: "secret stdout",
      stderr: "secret stderr",
      path: "/private/state/greppy",
      url: "https://credential.example.test/token",
    });
    const sanitized = toWorkjetGreppyOperationError(internal);

    assert.deepEqual(
      { ...sanitized },
      {
        _tag: "WorkjetGreppyOperationError",
        reason: "install-failed",
      },
    );
    assert.notInclude(JSON.stringify(sanitized), "secret");
    assert.notInclude(JSON.stringify(sanitized), "/private");
    assert.notInclude(JSON.stringify(sanitized), "https://");
  });

  it.effect("reports unsupported host pairs without guessing a binary", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime({ platform: "freebsd", arch: "riscv64" });
      const runtime = make({ stateDir: "/state", platform: fake.platform });
      assert.deepEqual(yield* runtime.inspect(), {
        availability: "unsupported",
        reason: "unsupported-host",
        version: "0.3.1",
        installSupported: false,
      });
      assert.equal((yield* runtime.install().pipe(Effect.flip)).reason, "unsupported-host");
    }),
  );

  it.effect("uses externally administered runtimes when managed installation is unsupported", () =>
    Effect.gen(function* () {
      const external = fakeRuntime({
        platform: "freebsd",
        arch: "riscv64",
        environment: { PATH: "/path/bin" },
      });
      seedValidExecutable(external, "/path/bin/greppy");
      assert.deepEqual(yield* make({ stateDir: "/state", platform: external.platform }).inspect(), {
        availability: "available",
        source: "path",
        version: "0.3.1",
        installSupported: false,
      });

      const windows = fakeRuntime({
        platform: "win32",
        arch: "x64",
        environment: { PATH: "/path/bin" },
      });
      seedValidExecutable(windows, "/path/bin/greppy.exe");
      const resolved = yield* make({ stateDir: "/state", platform: windows.platform }).resolve();
      assert.equal(resolved.source, "path");
      assert.equal(resolved.executable, "/path/bin/greppy.exe");
    }),
  );
});

describe("GreppyRuntime source install policy", () => {
  it("confines source, redirect, model, and archive paths", () => {
    assert.isTrue(
      isAllowedGreppyDownloadUrl(new URL(GREPPY_RUNTIME_PIN.sourceUrl), "source", true),
    );
    assert.isTrue(
      isAllowedGreppyDownloadUrl(
        new URL(
          "https://codeload.github.com/metric-space-ai/greppy/tar.gz/de078b47d1df5df7c086e4591162517328f979ec",
        ),
        "source",
        false,
      ),
    );
    assert.isFalse(
      isAllowedGreppyDownloadUrl(new URL("https://evil.example/source.tar.gz"), "source", false),
    );
    assert.isTrue(
      isAllowedGreppyDownloadUrl(new URL("https://us.aws.cdn.hf.co/xet/file"), "model", false),
    );
    assert.isFalse(
      isAllowedGreppyDownloadUrl(new URL("http://huggingface.co/file"), "model", false),
    );
    assert.isFalse(
      isAllowedGreppyDownloadUrl(
        new URL("https://huggingface.co.evil.example/file"),
        "model",
        false,
      ),
    );
    assert.isTrue(isConfinedGreppyAssetPath("/source", "crates/cli/assets/model/tokenizer.json"));
    assert.isFalse(isConfinedGreppyAssetPath("/source", "../outside/model.gguf"));
    assert.isFalse(isConfinedGreppyAssetPath("/source", "/absolute/model.gguf"));
    assert.isTrue(
      validateGreppyArchiveEntries([
        GREPPY_RUNTIME_PIN.archivePrefix,
        `${GREPPY_RUNTIME_PIN.archivePrefix}Cargo.lock`,
      ]),
    );
    assert.isFalse(validateGreppyArchiveEntries(["other-prefix/Cargo.lock"]));
    assert.isFalse(validateGreppyArchiveEntries([`${GREPPY_RUNTIME_PIN.archivePrefix}../outside`]));
    for (const asset of GREPPY_MODEL_ASSETS) assert.isDefined(greppyModelUrl(asset));
  });

  it.effect(
    "downloads verified source then exactly four assets, builds no-shell, and atomically activates",
    () =>
      Effect.gen(function* () {
        const fake = fakeRuntime({ run: installRun });
        const runtime = make({
          stateDir: "/server/state",
          platform: fake.platform,
          buildTempRoot: "/Volumes/tmp/workjet/managed-builds",
        });
        const snapshot = yield* runtime.install();
        assert.deepEqual(snapshot, {
          availability: "available",
          source: "managed",
          version: "0.3.1",
          installSupported: true,
        });
        assert.deepEqual(fake.tempParents, [
          "/Volumes/tmp/workjet/managed-builds",
          "/server/state/greppy-runtime",
        ]);
        assert.equal(fake.downloads.length, 5);
        assert.equal(fake.downloads[0]?.url, GREPPY_RUNTIME_PIN.sourceUrl);
        assert.deepEqual(
          fake.downloads.slice(1).map(({ url }) => url),
          GREPPY_MODEL_ASSETS.map((asset) => greppyModelUrl(asset)!.toString()),
        );
        const cargo = fake.commands.find((command) => command.executable === "cargo");
        assert.deepEqual(cargo?.args, GREPPY_RUNTIME_PIN.cargoArgs);
        assert.include(cargo?.cwd ?? "", "/Volumes/tmp/workjet/managed-builds/greppy-build-");
        assert.equal(fake.renames.length, 1);
        assert.equal(fake.renames[0]?.to, "/server/state/greppy-runtime/0.3.1");
        assert.isTrue(fake.executables.has("/server/state/greppy-runtime/0.3.1/greppy"));
        assert.equal(
          fake.files.get("/server/state/greppy-runtime/0.3.1/.install-complete"),
          completeSentinel,
        );
        assert.isTrue(
          fake.removed.some((path) =>
            path.startsWith("/Volumes/tmp/workjet/managed-builds/greppy-build-"),
          ),
        );
      }),
  );

  it.effect(
    "rejects checksum, redirect, archive, and bounded output failures and cleans staging",
    () =>
      Effect.gen(function* () {
        const cases = [
          fakeRuntime({
            run: installRun,
            download: async (request, _index, fake) => {
              const normal = await fakeRuntime().platform.download(request);
              return request.policy === "source" ? { ...normal, sha256: "0".repeat(64) } : normal;
            },
          }),
          fakeRuntime({
            run: installRun,
            download: async (request) => ({
              ...successfulDownloadResult(request),
              finalUrl: "https://evil.example/archive",
              redirects: ["https://evil.example/archive"],
            }),
          }),
          fakeRuntime({
            run: installRun,
            download: async (request) =>
              request.policy === "source"
                ? {
                    ...successfulDownloadResult(request),
                    bytes: __testing.constants.SOURCE_MAX_BYTES + 1,
                  }
                : successfulDownloadResult(request),
          }),
          fakeRuntime({
            run: installRun,
            download: async (request) =>
              request.policy === "model"
                ? { ...successfulDownloadResult(request), sha256: "0".repeat(64) }
                : successfulDownloadResult(request),
          }),
          fakeRuntime({
            run: installRun,
            download: async (request) =>
              request.policy === "model"
                ? {
                    ...successfulDownloadResult(request),
                    bytes: __testing.constants.MODEL_MAX_BYTES + 1,
                  }
                : successfulDownloadResult(request),
          }),
          fakeRuntime({
            run: async (command, index, fake) =>
              command.executable === "tar" && command.args[0] === "-tzf"
                ? result({ stdout: "wrong-prefix/Cargo.lock" })
                : installRun(command, index, fake),
          }),
          fakeRuntime({
            run: async (command, index, fake) =>
              command.executable === "cargo"
                ? result({ outputExceeded: true })
                : installRun(command, index, fake),
          }),
        ];
        for (const fake of cases) {
          const error = yield* make({ stateDir: "/state", platform: fake.platform })
            .install()
            .pipe(Effect.flip);
          assert.equal(error.reason, "install-failed");
          assert.isFalse(fake.executables.has("/state/greppy-runtime/0.3.1/greppy"));
          assert.isTrue(fake.removed.some((path) => path.includes("greppy-build-")));
          assert.isTrue(fake.removed.some((path) => path.includes(".greppy-activate-")));
        }
      }),
  );

  it.effect("preserves a completed prior runtime when an explicit repair fails", () =>
    Effect.gen(function* () {
      const stateDir = "/repair-state";
      const paths = __testing.runtimePaths(stateDir);
      const fake = fakeRuntime({
        run: async (command, index, current) =>
          command.executable === paths.executable && command.args[0] === "--version"
            ? result({ stdout: "greppy 0.2.0\n" })
            : installRun(command, index, current),
        download: async (request) => ({
          ...successfulDownloadResult(request),
          sha256:
            request.policy === "source" ? "0".repeat(64) : successfulDownloadResult(request).sha256,
        }),
      });
      seedManaged(fake, stateDir);
      const error = yield* make({ stateDir, platform: fake.platform }).install().pipe(Effect.flip);
      assert.equal(error.reason, "install-failed");
      assert.isTrue(fake.executables.has(paths.executable));
      assert.equal(fake.files.get(paths.sentinel), completeSentinel);
      assert.isFalse(fake.renames.some(({ from }) => from === paths.versionDir));
    }),
  );

  it.effect("serializes concurrent installs for one server state", () =>
    Effect.gen(function* () {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let sourceDownloads = 0;
      const fake = fakeRuntime({
        run: installRun,
        download: async (request, _index, current) => {
          if (request.policy === "source") {
            sourceDownloads += 1;
            await gate;
          }
          current.files.set(request.destination, "downloaded");
          const asset = GREPPY_MODEL_ASSETS.find(
            (candidate) =>
              request.url.includes(`/${candidate.repository}/`) &&
              request.url.endsWith(`/${candidate.file}`),
          );
          return request.policy === "source"
            ? {
                sha256: GREPPY_RUNTIME_PIN.sourceSha256,
                bytes: 1,
                finalUrl:
                  "https://codeload.github.com/metric-space-ai/greppy/tar.gz/de078b47d1df5df7c086e4591162517328f979ec",
                redirects: [],
              }
            : {
                sha256: asset!.sha256,
                bytes: 1,
                finalUrl: request.url,
                redirects: [],
              };
        },
      });
      const runtime = make({ stateDir: "/state", platform: fake.platform });
      const first = yield* runtime.install().pipe(Effect.forkChild);
      const second = yield* runtime.install().pipe(Effect.forkChild);
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            const poll = () => (sourceDownloads === 1 ? resolve() : setTimeout(poll, 0));
            poll();
          }),
      );
      assert.equal(sourceDownloads, 1);
      release();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.equal(sourceDownloads, 1);
    }),
  );
});

describe("GreppyRuntime workspace readiness", () => {
  function readyFake(statusResults: Array<RuntimeCommandResult>, onIndex?: () => Promise<void>) {
    return fakeRuntime({
      environment: { PATH: "/path/bin" },
      run: async (command) => {
        if (command.args[0] === "--version") return versionResult;
        if (command.args[0] === "search" && command.args[1] === "--help") return searchHelpResult;
        if (command.args[0] === "index" && command.args[1] === "--help") return indexHelpResult;
        if (command.args[0] === "index" && command.args[1] === "status") {
          return statusResults.shift() ?? result({ stdout: healthyStatus() });
        }
        if (command.args[0] === "index") {
          await onIndex?.();
          return result();
        }
        return result();
      },
    });
  }

  it.effect("accepts healthy, refreshes no-index/stale, and reports active indexing", () =>
    Effect.gen(function* () {
      const healthy = readyFake([result({ stdout: healthyStatus() })]);
      seedValidExecutable(healthy, "/path/bin/greppy");
      const healthyRuntime = make({ stateDir: "/server/state", platform: healthy.platform });
      const readiness = yield* healthyRuntime.ensureWorkspace("/worktrees/thread-one");
      assert.equal(readiness.status, "ready");
      assert.equal(readiness.cwd, "/canonical/worktrees/thread-one");
      assert.equal(readiness.storeDir, "/server/state/greppy");
      assert.notInclude(readiness.storeDir, "thread-one");

      for (const initial of [
        noIndexStatus,
        healthyStatus({ status: "unhealthy", healthy: false, fresh: false }),
      ]) {
        const stale = readyFake([
          result({ stdout: initial, exitCode: initial === noIndexStatus ? 1 : 0 }),
          result({ stdout: healthyStatus() }),
        ]);
        seedValidExecutable(stale, "/path/bin/greppy");
        const refreshed = yield* make({
          stateDir: "/server/state",
          platform: stale.platform,
        }).ensureWorkspace("/project");
        assert.equal(refreshed.status, "ready");
        assert.equal(
          stale.commands.filter(
            (command) =>
              command.args[0] === "index" &&
              command.args[1] !== "status" &&
              command.args[1] !== "--help",
          ).length,
          1,
        );
      }

      const indexing = readyFake([
        result({
          stdout: healthyStatus({
            status: "unhealthy",
            healthy: false,
            background_state: "refreshing",
            embedding_complete: false,
          }),
        }),
      ]);
      seedValidExecutable(indexing, "/path/bin/greppy");
      assert.equal(
        (yield* make({ stateDir: "/state", platform: indexing.platform }).ensureWorkspace(
          "/project",
        )).status,
        "indexing",
      );
    }),
  );

  it.effect("types malformed, oversized, timeout, and nonzero health failures", () =>
    Effect.gen(function* () {
      const cases = [
        { expected: "malformed-response", status: result({ stdout: "not-json" }) },
        {
          expected: "oversized-response",
          status: result({ stdout: healthyStatus(), stdoutBytes: 70_000 }),
        },
        { expected: "timeout", status: result({ timedOut: true }) },
        {
          expected: "process-exit",
          status: result({ stdout: healthyStatus(), exitCode: 7 }),
        },
      ] as const;
      for (const testCase of cases) {
        const fake = readyFake([testCase.status]);
        seedValidExecutable(fake, "/path/bin/greppy");
        const error = yield* make({ stateDir: "/state", platform: fake.platform })
          .ensureWorkspace("/project")
          .pipe(Effect.flip);
        assert.equal(error.reason, testCase.expected);
      }
    }),
  );

  it.effect("single-flights one index refresh per canonical cwd and keeps one shared store", () =>
    Effect.gen(function* () {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fake = readyFake(
        [result({ stdout: noIndexStatus, exitCode: 1 }), result({ stdout: healthyStatus() })],
        () => gate,
      );
      seedValidExecutable(fake, "/path/bin/greppy");
      const runtime = make({ stateDir: "/t3-state", platform: fake.platform });
      const first = yield* runtime
        .ensureWorkspace("/harness/codex/thread-a")
        .pipe(Effect.forkChild);
      const second = yield* runtime
        .ensureWorkspace("/harness/codex/thread-a")
        .pipe(Effect.forkChild);
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            const poll = () =>
              fake.commands.some(
                (command) =>
                  command.args[0] === "index" && command.args[1]?.startsWith("/canonical") === true,
              )
                ? resolve()
                : setTimeout(poll, 0);
            poll();
          }),
      );
      assert.equal(
        fake.commands.filter(
          (command) =>
            command.args[0] === "index" && command.args[1]?.startsWith("/canonical") === true,
        ).length,
        1,
      );
      release();
      const [one, two] = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      assert.equal(one.storeDir, "/t3-state/greppy");
      assert.equal(two.storeDir, "/t3-state/greppy");
      assert.notInclude(one.storeDir, "codex");
      assert.notInclude(one.storeDir, "thread-a");

      const other = readyFake([result({ stdout: healthyStatus() })]);
      seedValidExecutable(other, "/path/bin/greppy");
      const otherReadiness = yield* make({
        stateDir: "/t3-state",
        platform: other.platform,
      }).ensureWorkspace("/harness/claude/thread-b");
      assert.equal(otherReadiness.storeDir, one.storeDir);
      assert.notInclude(otherReadiness.storeDir, "claude");
      assert.notInclude(otherReadiness.storeDir, "thread-b");
    }),
  );
});
