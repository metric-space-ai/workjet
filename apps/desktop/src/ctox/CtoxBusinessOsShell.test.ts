// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off - exercises the Electron-owned loopback server with real Node HTTP and temporary files.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as CtoxBusinessOsShell from "./CtoxBusinessOsShell.ts";

const config: CtoxBusinessOsShell.CtoxBusinessOsLaunchConfig = {
  transport: "webrtc",
  sync_room: "ctox-business-os:office",
  signaling_urls: ["wss://signal.example.com/room"],
  signaling_room_password: "room-secret-must-not-leak",
  http_bridge_available: false,
  desktop_instance: {
    id: "paired:manual_pairing:abcdefghijklmnopqrstuv",
    source: "manual_pairing",
    display_name: "Office",
    domain: "",
  },
};
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function environment(input: {
  readonly rootDir: string;
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
}): DesktopEnvironment.DesktopEnvironment["Service"] {
  return DesktopEnvironment.DesktopEnvironment.of(
    input as DesktopEnvironment.DesktopEnvironment["Service"],
  );
}

function request(
  origin: string,
  path: string,
  method = "GET",
): Promise<{
  readonly body: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly status: number | undefined;
}> {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const req = NodeHttp.request(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode,
          }),
        );
      },
    );
    req.once("error", reject);
    req.end();
  });
}

async function shellRoot(base: string, packaged: boolean): Promise<string> {
  const env = environment({
    rootDir: NodePath.join(base, "repo"),
    resourcesPath: NodePath.join(base, "resources"),
    isPackaged: packaged,
  });
  const root = CtoxBusinessOsShell.resolveCtoxBusinessOsShellRoot(env);
  await NodeFSP.mkdir(root, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "index.html"), "<h1>Business OS</h1>");
  await NodeFSP.writeFile(
    NodePath.join(root, CtoxBusinessOsShell.CTOX_BUSINESS_OS_SHELL_COMPLETION_SENTINEL),
    `${encodeUnknownJson(CtoxBusinessOsShell.ctoxBusinessOsShellCompletionSentinel)}\n`,
  );
  await NodeFSP.mkdir(NodePath.join(root, "assets"));
  await NodeFSP.writeFile(NodePath.join(root, "assets", "app.js"), "export const ready = true;");
  await NodeFSP.mkdir(NodePath.join(root, "rxdb", "src"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "rxdb", "src", "v1_5_status.mjs"),
    "export const ready = true;",
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "rxdb", "src", "protocol-contract.generated.mjs"),
    "export const protocol = true;",
  );
  return root;
}

describe("CtoxBusinessOsShell", () => {
  it("resolves only an absolute established CTOX install root for local module assets", () => {
    assert.equal(
      CtoxBusinessOsShell.resolveCtoxLocalModuleAssetRoot(
        { CTOX_INSTALL_ROOT: "/opt/ctox" },
        "/home/workjet",
      ),
      "/opt/ctox/current/runtime/business-os",
    );
    assert.equal(
      CtoxBusinessOsShell.resolveCtoxLocalModuleAssetRoot({}, "/home/workjet"),
      "/home/workjet/.local/lib/ctox/current/runtime/business-os",
    );
    assert.isUndefined(
      CtoxBusinessOsShell.resolveCtoxLocalModuleAssetRoot(
        { CTOX_INSTALL_ROOT: "relative" },
        "/home/workjet",
      ),
    );
  });
  it("resolves only the exact packaged root and manifest-pinned development root", async () => {
    const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ctox-shell-root-"));
    try {
      expect(
        CtoxBusinessOsShell.resolveCtoxBusinessOsShellRoot(
          environment({ rootDir: "/repo", resourcesPath: "/resources", isPackaged: true }),
        ),
      ).toBe(NodePath.join("/resources", "ctox-business-os-shell"));
      expect(
        CtoxBusinessOsShell.resolveCtoxBusinessOsShellRoot(
          environment({ rootDir: "/repo", resourcesPath: "/resources", isPackaged: false }),
        ),
      ).toBe(NodePath.join("/repo", ".deps", "ctox-business-os-shell", "0.1.10"));
      await shellRoot(base, false);
    } finally {
      await NodeFSP.rm(base, { recursive: true, force: true });
    }
  });

  it("uses recovery only when the lifecycle explicitly requests it", () => {
    expect(CtoxBusinessOsShell.shouldUseCtoxRecoveryShell(undefined)).toBe(true);
    expect(
      CtoxBusinessOsShell.shouldUseCtoxRecoveryShell({
        activeVersion: "0.1.9",
        desiredVersion: null,
        latestCompatibleVersion: "0.1.9",
        channel: "stable",
        phase: "current",
        health: "healthy",
        administrable: true,
        recoveryShell: false,
        lastCheckedAt: null,
        lastActivatedAt: null,
        errorCode: null,
        pause: null,
      }),
    ).toBe(false);
    expect(
      CtoxBusinessOsShell.shouldUseCtoxRecoveryShell({
        activeVersion: "0.1.9",
        desiredVersion: null,
        latestCompatibleVersion: "0.1.9",
        channel: "stable",
        phase: "blocked",
        health: "unknown",
        administrable: false,
        recoveryShell: true,
        lastCheckedAt: null,
        lastActivatedAt: null,
        errorCode: "recovery-shell",
        pause: null,
      }),
    ).toBe(true);
  });

  it.effect("starts one loopback-only server and serves GET and HEAD static files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ctox-shell-http-"))),
      (base) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => shellRoot(base, false));
          const env = environment({
            rootDir: NodePath.join(base, "repo"),
            resourcesPath: NodePath.join(base, "resources"),
            isPackaged: false,
          });
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const shell = yield* CtoxBusinessOsShell.CtoxBusinessOsShell;
              const first = yield* shell.launch(config);
              const second = yield* shell.launch(config);
              assert.equal(first.launchOrigin, second.launchOrigin);
              const origin = new URL(first.launchOrigin);
              const launchUrl = new URL(first.launchUrl);
              assert.equal(origin.hostname, "127.0.0.1");
              assert.notEqual(origin.port, "");
              assert.equal(launchUrl.pathname, "/business-os/");
              const packed = launchUrl.searchParams.get("ctox_config");
              if (packed === null) assert.fail("ctox_config is required");
              assert.deepEqual(
                decodeUnknownJson(Buffer.from(packed, "base64url").toString("utf8")),
                config,
              );

              const get = yield* Effect.promise(() =>
                request(first.launchOrigin, launchUrl.pathname),
              );
              const head = yield* Effect.promise(() =>
                request(first.launchOrigin, "/business-os/assets/app.js", "HEAD"),
              );
              const rxdbStaticModule = yield* Effect.promise(() =>
                request(first.launchOrigin, "/business-os/rxdb/src/v1_5_status.mjs"),
              );
              const rxdbStaticContract = yield* Effect.promise(() =>
                request(
                  first.launchOrigin,
                  "/business-os/rxdb/src/protocol-contract.generated.mjs",
                ),
              );
              assert.equal(get.status, 200);
              assert.equal(get.body, "<h1>Business OS</h1>");
              assert.equal(get.headers["cache-control"], "no-store");
              assert.equal(get.headers["referrer-policy"], "no-referrer");
              assert.equal(get.headers["x-content-type-options"], "nosniff");
              assert.equal(get.headers["content-type"], "text/html; charset=utf-8");
              assert.equal(head.status, 200);
              assert.equal(head.body, "");
              assert.equal(head.headers["content-type"], "text/javascript; charset=utf-8");
              assert.equal(rxdbStaticModule.status, 200);
              assert.equal(rxdbStaticModule.body, "export const ready = true;");
              assert.equal(rxdbStaticContract.status, 200);
              assert.equal(rxdbStaticContract.body, "export const protocol = true;");
              return first.launchOrigin;
            }).pipe(
              Effect.provide(CtoxBusinessOsShell.layer),
              Effect.provideService(DesktopEnvironment.DesktopEnvironment, env),
            ),
          );
          const closed = yield* Effect.tryPromise(() => request(result, "/")).pipe(Effect.flip);
          assert.isDefined(closed);
        }),
      (base) => Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true })),
    ),
  );

  it.effect("serves local instance modules without allowing them to replace shell files", () => {
    const previousInstallRoot = process.env.CTOX_INSTALL_ROOT;
    return Effect.acquireUseRelease(
      Effect.promise(async () => {
        const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ctox-module-http-"));
        process.env.CTOX_INSTALL_ROOT = NodePath.join(base, "install");
        return base;
      }),
      (base) =>
        Effect.gen(function* () {
          const root = yield* Effect.promise(() => shellRoot(base, false));
          const runtimeRoot = NodePath.join(base, "install", "current", "runtime", "business-os");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(NodePath.dirname(runtimeRoot), { recursive: true });
            const identity = NodePath.join(
              NodePath.dirname(runtimeRoot),
              "business-os-instance-id",
            );
            await NodeFSP.writeFile(identity, "biz_local\n", { mode: 0o600 });
            await NodeFSP.chmod(identity, 0o600);
          });
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.join(root, "installed-modules", "shell-owned"), {
              recursive: true,
            }),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(root, "installed-modules", "shell-owned", "index.js"),
              "export const owner = 'shell';",
            ),
          );
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.join(runtimeRoot, "installed-modules", "instance-owned"), {
              recursive: true,
            }),
          );
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.join(runtimeRoot, "installed-modules", "shell-owned"), {
              recursive: true,
            }),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(runtimeRoot, "installed-modules", "instance-owned", "index.js"),
              "export const owner = 'instance';",
            ),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(runtimeRoot, "installed-modules", "instance-owned", "module.json"),
              encodeUnknownJson({
                id: "instance-owned",
                version: "1.0.0",
                distribution: "public",
              }),
            ),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(runtimeRoot, "installed-modules", "shell-owned", "module.json"),
              encodeUnknownJson({
                id: "shell-owned",
                version: "1.0.0",
                distribution: "public",
              }),
            ),
          );
          yield* Effect.promise(async () => {
            const privateDir = NodePath.join(
              runtimeRoot,
              "installed-modules",
              "rem-unbound-private",
            );
            await NodeFSP.mkdir(privateDir, { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(privateDir, "module.json"),
              encodeUnknownJson({
                id: "rem-unbound-private",
                version: "1.0.0",
                distribution: "customer",
              }),
            );
            await NodeFSP.writeFile(NodePath.join(privateDir, "index.js"), "private");
          });
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(runtimeRoot, "installed-modules", "shell-owned", "index.js"),
              "export const owner = 'overlay';",
            ),
          );
          const env = environment({
            rootDir: NodePath.join(base, "repo"),
            resourcesPath: NodePath.join(base, "resources"),
            isPackaged: false,
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const shell = yield* CtoxBusinessOsShell.CtoxBusinessOsShell;
              const launch = yield* shell.launch({
                ...config,
                desktop_instance: {
                  ...config.desktop_instance,
                  id: "local:ctox",
                  source: "local_daemon",
                },
              });
              const instanceOwned = yield* Effect.promise(() =>
                request(
                  launch.launchOrigin,
                  "/business-os/installed-modules/instance-owned/index.js",
                ),
              );
              const shellOwned = yield* Effect.promise(() =>
                request(launch.launchOrigin, "/business-os/installed-modules/shell-owned/index.js"),
              );
              assert.equal(instanceOwned.status, 200);
              assert.equal(instanceOwned.body, "export const owner = 'instance';");
              assert.equal(shellOwned.status, 200);
              assert.equal(shellOwned.body, "export const owner = 'shell';");
              const fallbackIcon = yield* Effect.promise(() =>
                request(
                  launch.launchOrigin,
                  "/business-os/installed-modules/instance-owned/icon.svg",
                ),
              );
              assert.equal(fallbackIcon.status, 200);
              assert.equal(fallbackIcon.headers["content-type"], "image/svg+xml");
              assert.include(fallbackIcon.body, 'viewBox="0 0 24 24"');
              const missingModuleFile = yield* Effect.promise(() =>
                request(
                  launch.launchOrigin,
                  "/business-os/installed-modules/instance-owned/schema.js",
                ),
              );
              assert.equal(missingModuleFile.status, 404);
              const unboundCustomerAsset = yield* Effect.promise(() =>
                request(
                  launch.launchOrigin,
                  "/business-os/installed-modules/rem-unbound-private/index.js",
                ),
              );
              const unboundCustomerFallbackIcon = yield* Effect.promise(() =>
                request(
                  launch.launchOrigin,
                  "/business-os/installed-modules/rem-unbound-private/icon.svg",
                ),
              );
              assert.equal(unboundCustomerAsset.status, 404);
              assert.equal(unboundCustomerFallbackIcon.status, 404);
            }).pipe(
              Effect.provide(CtoxBusinessOsShell.layer),
              Effect.provideService(DesktopEnvironment.DesktopEnvironment, env),
            ),
          );
        }),
      (base) =>
        Effect.promise(async () => {
          if (previousInstallRoot === undefined) delete process.env.CTOX_INSTALL_ROOT;
          else process.env.CTOX_INSTALL_ROOT = previousInstallRoot;
          await NodeFSP.rm(base, { recursive: true, force: true });
        }),
    );
  });

  it.effect("rejects traversal, symlinks, methods, malformed paths, and data routes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ctox-shell-guard-"))),
      (base) =>
        Effect.gen(function* () {
          const root = yield* Effect.promise(() => shellRoot(base, true));
          const outside = NodePath.join(base, "outside.txt");
          yield* Effect.promise(() => NodeFSP.writeFile(outside, "outside-secret"));
          yield* Effect.promise(() => NodeFSP.symlink(outside, NodePath.join(root, "escape.txt")));
          const env = environment({
            rootDir: NodePath.join(base, "repo"),
            resourcesPath: NodePath.join(base, "resources"),
            isPackaged: true,
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const shell = yield* CtoxBusinessOsShell.CtoxBusinessOsShell;
              const launch = yield* shell.launch(config);
              for (const [path, method, expected] of [
                ["/%2e%2e/outside.txt", "GET", 400],
                ["/escape.txt", "GET", 403],
                ["/assets/app.js", "POST", 405],
                ["/%", "GET", 400],
                ["/api/business-os/status", "GET", 403],
                ["/business-os/api/business-os/status", "GET", 403],
                ["/api/business-os/collections", "GET", 403],
                ["/business-os/commands", "GET", 403],
                ["/business-os/rxdb/src/private.mjs", "GET", 403],
                ["/commands", "GET", 403],
                ["/files", "GET", 403],
                ["/session", "GET", 403],
                ["/missing.txt", "GET", 404],
              ] as const) {
                const response = yield* Effect.promise(() =>
                  request(launch.launchOrigin, path, method),
                );
                assert.equal(response.status, expected);
                assert.notInclude(response.body, "outside-secret");
                assert.equal(response.headers["cache-control"], "no-store");
                assert.equal(response.headers["x-content-type-options"], "nosniff");
              }
            }).pipe(
              Effect.provide(CtoxBusinessOsShell.layer),
              Effect.provideService(DesktopEnvironment.DesktopEnvironment, env),
            ),
          );
        }),
      (base) => Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true })),
    ),
  );

  it.effect("uses one fixed secret-free error when the pinned shell is unavailable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ctox-shell-error-"))),
      (base) => {
        const env = environment({
          rootDir: NodePath.join(base, "room-secret-must-not-leak"),
          resourcesPath: NodePath.join(base, "resources"),
          isPackaged: false,
        });
        return Effect.scoped(
          Effect.gen(function* () {
            const shell = yield* CtoxBusinessOsShell.CtoxBusinessOsShell;
            const error = yield* shell.launch(config).pipe(Effect.flip);
            assert.equal(error.message, "The CTOX Business OS shell could not be launched.");
            assert.notInclude(error.message, "room-secret-must-not-leak");
            assert.notInclude(error.message, base);
          }).pipe(
            Effect.provide(CtoxBusinessOsShell.layer),
            Effect.provideService(DesktopEnvironment.DesktopEnvironment, env),
          ),
        );
      },
      (base) => Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true })),
    ),
  );

  it.effect("rejects a shell directory without the pinned completion sentinel", () =>
    Effect.acquireUseRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ctox-shell-unverified-")),
      ),
      (base) =>
        Effect.gen(function* () {
          const root = NodePath.join(base, "resources", "ctox-business-os-shell");
          yield* Effect.promise(() => NodeFSP.mkdir(root, { recursive: true }));
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(root, "index.html"), "unsafe"),
          );
          const shell = yield* CtoxBusinessOsShell.CtoxBusinessOsShell;
          const error = yield* shell.launch(config).pipe(Effect.flip);
          assert.equal(error.message, "The CTOX Business OS shell could not be launched.");
        }).pipe(
          Effect.provide(CtoxBusinessOsShell.layer),
          Effect.provideService(
            DesktopEnvironment.DesktopEnvironment,
            environment({
              rootDir: NodePath.join(base, "repo"),
              resourcesPath: NodePath.join(base, "resources"),
              isPackaged: true,
            }),
          ),
          Effect.scoped,
        ),
      (base) => Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true })),
    ),
  );
});
