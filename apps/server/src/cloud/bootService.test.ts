import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from "@workjet/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";
import { acquireProfileOwnership } from "../profileOwnership.ts";
import { pinnedRuntimePaths } from "./pinnedRuntime.ts";
import { BUNDLED_RUNTIME_RECEIPT, bundledRuntimeNodePath } from "./bundledRuntime.ts";
import {
  parseServiceState,
  SERVICE_LAUNCHER_PROTOCOL,
  serviceStateHasPendingUpdate,
} from "./serviceProtocol.ts";

it("keeps systemd pinned to the stable launcher rather than a versioned server", () => {
  const unit = BootService.renderBootServiceUnit({
    nodePath: "/usr/bin/node",
    launcherPath: "/home/theo/.workjet/runtime/service-launcher.mjs",
    baseDir: "/home/theo/.workjet",
    logPath: "/home/theo/.workjet/userdata/logs/boot-service.log",
    unitPath: "/home/theo/.config/systemd/user/workjet.service",
  });

  expect(unit).toContain(
    "ExecStart=/usr/bin/node /home/theo/.workjet/runtime/service-launcher.mjs",
  );
  expect(unit).toContain("KillMode=mixed");
  expect(unit).not.toContain("versions/1.2.3");
});

it("survives the kernel OOM-killing a greedy agent child", () => {
  const unit = BootService.renderBootServiceUnit({
    nodePath: "/usr/bin/node",
    launcherPath: "/home/theo/.workjet/runtime/service-launcher.mjs",
    baseDir: "/home/theo/.workjet",
    logPath: "/home/theo/.workjet/userdata/logs/boot-service.log",
    unitPath: "/home/theo/.config/systemd/user/workjet.service",
  });

  expect(unit).toContain("OOMPolicy=continue");
});

it("renders launchd arguments as XML values and separates profile identities", () => {
  const plan: BootService.BootServicePlan = {
    nodePath: "/Applications/Node & Tools/node",
    launcherPath: "/Users/me/Profile <one>/runtime/service-launcher.mjs",
    baseDir: "/Users/me/Profile <one>",
    logPath: '/Users/me/Profile <one>/logs/"boot".log',
    unitPath: "/Users/me/Library/LaunchAgents/test.plist",
  };
  const plist = BootService.renderBootServiceLaunchAgent(plan);
  expect(plist).toContain("<string>/Applications/Node &amp; Tools/node</string>");
  expect(plist).toContain("Profile &lt;one&gt;/runtime/service-launcher.mjs</string>");
  expect(plist).toContain("&quot;boot&quot;.log</string>");
  expect(plist).toContain("<key>KeepAlive</key><true/>");
  expect(plist).not.toContain("/bin/sh");
  expect(BootService.bootServiceLaunchAgentLabel(plan.baseDir)).not.toBe(
    BootService.bootServiceLaunchAgentLabel("/Users/me/Profile <two>"),
  );
});

const makeHarness = Effect.fn("test.make_boot_service_harness")(function* (
  platform: NodeJS.Platform = "linux",
  usePinnedLauncher = false,
  aliasProfile = false,
  bundled = false,
  desktop?: BootService.BootServiceHost["desktop"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-boot-service-test-" });
  const baseDir = path.join(home, ".workjet");
  const sourceLauncher = path.join(home, "service-launcher.mjs");
  const statePath = path.join(baseDir, "runtime", "service-state.json");
  const profileAlias = path.join(home, "profile-alias");
  yield* fs.writeFileString(sourceLauncher, "export {};\n");
  const runtime = pinnedRuntimePaths(path, baseDir, "1.2.3");
  yield* fs.makeDirectory(path.dirname(runtime.entryPath), { recursive: true });
  yield* fs.writeFileString(runtime.entryPath, "export {};\n");
  yield* fs.writeFileString(
    path.join(path.dirname(runtime.entryPath), "service-launcher.mjs"),
    "export const source = 'pinned runtime';\n",
  );
  yield* fs.writeFileString(runtime.sentinelPath, "1.2.3\n");
  const bundle = bundled
    ? { archivePath: path.join(home, "shipped.tgz"), sha256: "a".repeat(64) }
    : undefined;
  if (bundle !== undefined) {
    const nodePath = bundledRuntimeNodePath(runtime.entryPath);
    yield* fs.makeDirectory(path.dirname(nodePath), { recursive: true });
    yield* fs.writeFileString(nodePath, "fixture");
    yield* fs.writeFileString(
      path.join(runtime.versionDir, BUNDLED_RUNTIME_RECEIPT),
      `${bundle.sha256}\n`,
    );
  }
  if (aliasProfile) yield* fs.symlink(baseDir, profileAlias);

  const commands: string[] = [];
  const control: {
    failCommand: string | undefined;
    timeoutCommand: string | undefined;
    supportsWait: boolean;
  } = {
    failCommand: undefined,
    timeoutCommand: undefined,
    supportsWait: true,
  };
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        const command = `${input.command} ${input.args.join(" ")}`;
        commands.push(command);
        return {
          stdout:
            input.args[1] === "--version"
              ? "workjet v1.2.3\n"
              : command === "/bin/launchctl help bootout" && control.supportsWait
                ? "bootout [--wait] <service-target>"
                : "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(command === control.failCommand ? 1 : 0),
          timedOut: command === control.timeoutCommand,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const service = yield* BootService.make({
    baseDir: aliasProfile ? profileAlias : baseDir,
    logsDir: path.join(baseDir, "userdata", "logs"),
    cliVersion: "1.2.3",
    host: {
      execPath: "/usr/bin/node",
      ...(desktop === undefined ? {} : { desktop }),
      ...(bundle === undefined ? {} : { bundle }),
      ...(usePinnedLauncher ? {} : { launcherSourcePath: sourceLauncher }),
    },
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcessPlatform, platform),
        Layer.succeed(HostProcessUserId, 501),
        Layer.succeed(HostProcessExecutablePath, "/usr/bin/node"),
        Layer.succeed(HostProcessArguments, ["/usr/bin/node", path.join(home, "bin.mjs")]),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })),
      ),
    ),
  );
  return { service, fs, statePath, commands, control, baseDir, runtime, path };
});

it.layer(NodeServices.layer)("bundled service executable", (it) => {
  it.effect(
    "persists Desktop launch settings and reports mismatching endpoints as needing explicit update",
    () =>
      Effect.gen(function* () {
        const desktop = {
          port: 4582,
          host: "127.0.0.1" as const,
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        };
        const { service, fs, statePath } = yield* makeHarness(
          "darwin",
          false,
          false,
          true,
          desktop,
        );
        yield* service.install;
        const status = yield* service.status;
        expect(status.current).toBe(true);
        expect(status.desktop).toEqual(desktop);
        const state = parseServiceState(yield* fs.readFileString(statePath));
        expect(state?.desktop).toEqual(desktop);
        yield* fs.writeFileString(
          statePath,
          JSON.stringify({ ...state, desktop: { ...desktop, port: 4583 } }),
        );
        expect((yield* service.status).current).toBe(false);
      }),
  );

  it.effect("preserves a Desktop endpoint during an ordinary CLI service repair", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness("darwin");
      yield* service.install;
      const state = parseServiceState(yield* fs.readFileString(statePath));
      const desktop = {
        port: 4852,
        host: "::1",
        tailscaleServeEnabled: true,
        tailscaleServePort: 8443,
      };
      yield* fs.writeFileString(statePath, JSON.stringify({ ...state, desktop }));
      yield* service.install;
      expect(parseServiceState(yield* fs.readFileString(statePath))?.desktop).toEqual(desktop);
      expect((yield* service.status).desktop).toEqual(desktop);
    }),
  );

  for (const platform of ["darwin", "linux"] as const) {
    it.effect(
      `pins ${platform} to imported Node and launcher, ignoring a mutable launcher override`,
      () =>
        Effect.gen(function* () {
          const { service, fs, commands, runtime } = yield* makeHarness(
            platform,
            false,
            false,
            true,
          );
          const plan = yield* service.install;
          expect(plan.nodePath).toBe(bundledRuntimeNodePath(runtime.entryPath));
          expect(commands).toContain(`${plan.nodePath} ${runtime.entryPath} --version`);
          expect(yield* fs.readFileString(plan.launcherPath)).toBe(
            "export const source = 'pinned runtime';\n",
          );
          expect(yield* fs.readFileString(plan.unitPath)).toContain(plan.nodePath);
          expect((yield* service.status).current).toBe(true);
        }),
    );
  }
  it.effect(
    "reports different content as stale and refuses installation before stopping the existing service",
    () =>
      Effect.gen(function* () {
        const { service, fs, commands, runtime, path } = yield* makeHarness(
          "darwin",
          false,
          false,
          true,
        );
        yield* service.install;
        yield* fs.writeFileString(
          path.join(runtime.versionDir, BUNDLED_RUNTIME_RECEIPT),
          `${"b".repeat(64)}\n`,
        );
        expect((yield* service.status).current).toBe(false);
        commands.length = 0;
        yield* service.install.pipe(Effect.flip);
        expect(commands.some((command) => command.includes("bootout --wait"))).toBe(false);
        expect(commands.some((command) => command.includes(" bootstrap "))).toBe(false);
      }),
  );
});

it.layer(NodeServices.layer)("boot service install", (it) => {
  it.effect("installs, reports current state, and uninstalls", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      const plan = yield* service.install;

      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
      });
      expect(yield* fs.readFileString(plan.launcherPath)).toBe("export {};\n");
      expect((yield* service.status).current).toBe(true);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned test document.
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
        update: {
          id: "u",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          dbPath: "/tmp/state.sqlite",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      expect((yield* service.status).current).toBe(false);
      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
      expect(commands.some((command) => command.startsWith("npm "))).toBe(false);
    }),
  );

  it.effect(
    "rejects concurrent administration before stopping or changing the installed service",
    () =>
      Effect.gen(function* () {
        const { service, fs, baseDir, statePath, commands } = yield* makeHarness();
        yield* service.install;
        const before = yield* fs.readFileString(statePath);
        commands.length = 0;
        yield* Effect.acquireRelease(
          Effect.tryPromise(() => acquireProfileOwnership(baseDir, "administration")),
          (ownership) => Effect.sync(() => ownership.release()),
        );
        expect((yield* service.install.pipe(Effect.flip))._tag).toBe("BootServiceInstallError");
        expect((yield* service.uninstall.pipe(Effect.flip))._tag).toBe("BootServiceInstallError");
        expect(commands).toEqual([]);
        expect(yield* fs.readFileString(statePath)).toBe(before);
      }),
  );

  it.effect("refuses mutable service files when another launcher still owns the profile", () =>
    Effect.gen(function* () {
      const { service, fs, baseDir, statePath, commands } = yield* makeHarness();
      const plan = yield* service.install;
      const before = yield* fs.readFileString(statePath);
      commands.length = 0;
      yield* Effect.acquireRelease(
        Effect.tryPromise(() => acquireProfileOwnership(baseDir, "launcher")),
        (ownership) => Effect.sync(() => ownership.release()),
      );
      expect((yield* service.install.pipe(Effect.flip))._tag).toBe("BootServiceInstallError");
      expect(yield* fs.readFileString(statePath)).toBe(before);
      expect(yield* fs.exists(plan.unitPath)).toBe(true);
      expect(commands.filter((command) => command.startsWith("systemctl "))).toEqual([
        "systemctl --user stop workjet.service",
      ]);
    }),
  );

  it.effect("copies the launcher from the prepared pinned runtime", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness("linux", true);
      const plan = yield* service.install;

      expect(yield* fs.readFileString(plan.launcherPath)).toBe(
        "export const source = 'pinned runtime';\n",
      );
    }),
  );

  it.effect("restarts an installed service when repair fails", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      yield* service.install;
      commands.length = 0;
      control.failCommand = "systemctl --user daemon-reload";

      const error = yield* service.install.pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(commands.filter((command) => command.startsWith("systemctl "))).toEqual([
        "systemctl --user stop workjet.service",
        "systemctl --user daemon-reload",
        "systemctl --user restart workjet.service",
      ]);
    }),
  );

  it.effect("restarts without overwriting a pending remote update", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      yield* service.install;
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned test document.
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL - 1,
        activeVersion: "1.2.3",
        update: {
          id: "remote-update",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      commands.length = 0;

      expect((yield* service.install.pipe(Effect.flip))._tag).toBe("BootServiceUpdatePendingError");
      expect(serviceStateHasPendingUpdate(yield* fs.readFileString(statePath))).toBe(true);
      expect(commands.filter((command) => command.startsWith("systemctl "))).toEqual([
        "systemctl --user stop workjet.service",
        "systemctl --user restart workjet.service",
      ]);
    }),
  );

  it.effect("installs, updates and removes a macOS login agent with a stable profile label", () =>
    Effect.gen(function* () {
      const { service, fs, commands } = yield* makeHarness("darwin");
      const plan = yield* service.install;
      const label = BootService.bootServiceLaunchAgentLabel(plan.baseDir);
      const bootstrap = `/bin/launchctl bootstrap gui/501 ${plan.unitPath}`;
      const bootout = `/bin/launchctl bootout --wait gui/501/${label}`;
      expect(plan.unitPath).toContain(`/Library/LaunchAgents/${label}.plist`);
      expect(yield* fs.readFileString(plan.unitPath)).toBe(
        BootService.renderBootServiceLaunchAgent(plan),
      );
      expect(yield* service.status).toMatchObject({ current: true, loginSessionOnly: true });
      yield* service.install;
      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
      expect(commands.filter((command) => !command.startsWith("/usr/bin/node "))).toEqual([
        "/bin/launchctl help bootout",
        bootstrap,
        "/bin/launchctl help bootout",
        bootout,
        bootstrap,
        "/bin/launchctl help bootout",
        bootout,
      ]);
      expect(yield* fs.exists(plan.launcherPath)).toBe(true);
    }),
  );

  it.effect("canonicalizes a macOS profile alias before selecting its service owner", () =>
    Effect.gen(function* () {
      const { service, fs, baseDir } = yield* makeHarness("darwin", false, true);
      const plan = yield* service.install;
      expect(plan.baseDir).toBe(yield* fs.realPath(baseDir));
      expect(plan.unitPath).toContain(BootService.bootServiceLaunchAgentLabel(plan.baseDir));
      expect(plan.launcherPath).toBe(`${plan.baseDir}/runtime/service-launcher.mjs`);
    }),
  );

  it.effect("preserves macOS runtime files and avoids restart after an unconfirmed stop", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, control } = yield* makeHarness("darwin");
      const plan = yield* service.install;
      const originalState = yield* fs.readFileString(statePath);
      const originalUnit = yield* fs.readFileString(plan.unitPath);
      const bootout = `/bin/launchctl bootout --wait gui/501/${BootService.bootServiceLaunchAgentLabel(plan.baseDir)}`;
      for (const mode of ["failCommand", "timeoutCommand"] as const) {
        commands.length = 0;
        control[mode] = bootout;
        expect((yield* service.install.pipe(Effect.flip))._tag).toBe("BootServiceCommandError");
        expect(yield* fs.readFileString(statePath)).toBe(originalState);
        expect(yield* fs.readFileString(plan.unitPath)).toBe(originalUnit);
        expect(commands.filter((command) => command.startsWith("/bin/launchctl "))).toEqual([
          "/bin/launchctl help bootout",
          bootout,
        ]);
        expect((yield* service.uninstall.pipe(Effect.flip))._tag).toBe("BootServiceCommandError");
        expect(yield* fs.exists(plan.unitPath)).toBe(true);
        control[mode] = undefined;
      }
    }),
  );

  it.effect("restores a stopped macOS job without overwriting a pending launcher update", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness("darwin");
      const plan = yield* service.install;
      // @effect-diagnostics-next-line preferSchemaOverJson:off - launcher-owned test document.
      const pending = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
        update: {
          id: "remote",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          dbPath: "/test/state.sqlite",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pending);
      commands.length = 0;
      expect((yield* service.install.pipe(Effect.flip))._tag).toBe("BootServiceUpdatePendingError");
      expect(yield* fs.readFileString(statePath)).toBe(pending);
      expect(commands.filter((command) => command.startsWith("/bin/launchctl "))).toEqual([
        "/bin/launchctl help bootout",
        `/bin/launchctl bootout --wait gui/501/${BootService.bootServiceLaunchAgentLabel(plan.baseDir)}`,
        `/bin/launchctl bootstrap gui/501 ${plan.unitPath}`,
      ]);
    }),
  );

  it.effect("refuses first install before writing a plist if launchctl cannot confirm a stop", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, control } = yield* makeHarness("darwin");
      const status = yield* service.status;
      control.supportsWait = false;
      expect((yield* service.install.pipe(Effect.flip))._tag).toBe("BootServiceCommandError");
      expect(commands).toEqual(["/bin/launchctl help bootout"]);
      expect(yield* fs.exists(status.unitPath)).toBe(false);
      expect(yield* fs.exists(statePath)).toBe(false);
    }),
  );

  it.effect("fails closed on unsupported platforms", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness("win32");
      expect((yield* service.status).supported).toBe(false);
      expect((yield* service.install.pipe(Effect.flip))._tag).toBe("BootServiceUnsupportedError");
    }),
  );
});
