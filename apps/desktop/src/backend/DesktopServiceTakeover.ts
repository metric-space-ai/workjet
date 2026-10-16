import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const { logInfo: logTakeoverInfo, logWarning: logTakeoverWarning } = makeComponentLogger(
  "desktop-service-takeover",
);

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  /** Executable path (macOS `ps -o comm=`) or `/proc/<pid>/exe` target on Linux. */
  readonly executable: string;
}

/** Parses `ps -o pid=,ppid=,comm=` output; the executable keeps embedded spaces. */
export const parseProcessTable = (stdout: string): ReadonlyArray<ProcessEntry> =>
  stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match === null) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), executable: match[3] ?? "" }];
  });

/** `/X.app/Contents/MacOS/<name>` → `/X.app`; any other executable → its directory. */
export const installationRootOf = (executable: string): string => {
  const bundle = /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable);
  if (bundle?.[1] !== undefined) return bundle[1];
  const slash = executable.lastIndexOf("/");
  return slash <= 0 ? executable : executable.slice(0, slash);
};

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export interface OtherInstallationInput {
  readonly ownPid: number;
  readonly ownExecutable: string;
  readonly processes: ReadonlyArray<ProcessEntry>;
  /** PIDs holding the profile's ownership locks (service or foreground owner). */
  readonly lockHolderPids?: ReadonlyArray<number>;
  /** Bundle identifier per installation root; `undefined` = unreadable, treated as the same app. */
  readonly bundleIdOf?: (root: string) => string | undefined;
}

/**
 * Installation roots of other running Workjet apps with this app's identity.
 * Excluded: this process and its descendants (renderer helpers, CLI children run
 * with ELECTRON_RUN_AS_NODE) and any process of this very installation root — a
 * predecessor of the same app that is still exiting after an update is this app,
 * so the new version takes over silently.
 */
export const findOtherInstallations = (input: OtherInstallationInput): ReadonlyArray<string> => {
  const parents = new Map(input.processes.map((entry) => [entry.pid, entry.ppid]));
  const descendsFromSelf = (pid: number) => {
    const seen = new Set<number>();
    let current: number | undefined = pid;
    while (current !== undefined && current > 1 && !seen.has(current)) {
      if (current === input.ownPid) return true;
      seen.add(current);
      current = parents.get(current);
    }
    return false;
  };
  const ownRoot = installationRootOf(input.ownExecutable);
  const ownName = basename(input.ownExecutable);
  const ownBundleId = input.bundleIdOf?.(ownRoot);
  const lockHolders = new Set(input.lockHolderPids ?? []);
  const roots = new Set<string>();
  for (const entry of input.processes) {
    if (descendsFromSelf(entry.pid)) continue;
    const root = installationRootOf(entry.executable);
    if (root === ownRoot) continue;
    const bundleId = input.bundleIdOf?.(root);
    const sameIdentity =
      ownBundleId !== undefined && bundleId !== undefined
        ? bundleId === ownBundleId
        : basename(entry.executable) === ownName;
    // A profile-lock holder from another app bundle of unknown identity counts too.
    const foreignLockHolder =
      lockHolders.has(entry.pid) && root.endsWith(".app") && bundleId === undefined;
    if (sameIdentity || foreignLockHolder) roots.add(root);
  }
  return [...roots].toSorted();
};

export const parseBundleIdentifier = (plist: string): string | undefined =>
  /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];

/**
 * No question when nothing else holds the service: reconnect or take over
 * silently. Only a detected other installation shows the in-app line and waits
 * for "Übernehmen". A failed detection is treated like a detected installation.
 */
export const makeTakeoverGate = <E>(dependencies: {
  readonly detect: Effect.Effect<ReadonlyArray<string>, E>;
  readonly awaitTakeover: Effect.Effect<boolean>;
}): Effect.Effect<boolean> =>
  dependencies.detect.pipe(
    Effect.map((roots) => roots.length > 0),
    Effect.orElseSucceed(() => true),
    Effect.flatMap((otherInstallationActive) =>
      otherInstallationActive ? dependencies.awaitTakeover : Effect.succeed(true),
    ),
  );

export class DesktopServiceTakeover extends Context.Service<
  DesktopServiceTakeover,
  { readonly confirm: Effect.Effect<boolean> }
>()("@workjet/desktop/backend/DesktopServiceTakeover") {}

export const layer = Layer.effect(
  DesktopServiceTakeover,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const run = (command: string, args: ReadonlyArray<string>) =>
      spawner.string(ChildProcess.make(command, [...args])).pipe(Effect.timeout("5 seconds"));
    const listProcesses = Effect.gen(function* () {
      if (environment.platform === "darwin")
        return parseProcessTable(yield* run("/bin/ps", ["-axo", "pid=,ppid=,comm="]));
      const table = parseProcessTable(yield* run("ps", ["-eo", "pid=,ppid=,comm="]));
      // Linux `comm` is a 15-character name; resolve the real executable.
      return yield* Effect.forEach(table, (entry) =>
        fs.readLink(`/proc/${entry.pid}/exe`).pipe(
          Effect.map((executable) => ({ ...entry, executable })),
          Effect.orElseSucceed(() => entry),
        ),
      );
    });
    const lockHolders = Effect.gen(function* () {
      const directory = path.join(environment.baseDir, "runtime", "ownership");
      const files = (yield* fs.readDirectory(directory)).map((name) => path.join(directory, name));
      if (files.length === 0) return [];
      const stdout = yield* run("lsof", ["-t", "--", ...files]);
      return stdout
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<number> => []));
    const bundleIds = new Map<string, string | undefined>();
    const readBundleIds = (roots: Iterable<string>) =>
      Effect.forEach(
        [...roots].filter((root) => root.endsWith(".app") && !bundleIds.has(root)),
        (root) =>
          fs.readFileString(path.join(root, "Contents", "Info.plist")).pipe(
            Effect.map(parseBundleIdentifier),
            Effect.orElseSucceed(() => undefined),
            Effect.tap((id) => Effect.sync(() => bundleIds.set(root, id))),
          ),
        { discard: true },
      );
    const detect = Effect.gen(function* () {
      const processes = yield* listProcesses;
      const lockHolderPids = yield* lockHolders;
      const ownExecutable = process.execPath;
      yield* readBundleIds([
        installationRootOf(ownExecutable),
        ...processes.map((entry) => installationRootOf(entry.executable)),
      ]);
      return findOtherInstallations({
        ownPid: process.pid,
        ownExecutable,
        processes,
        lockHolderPids,
        bundleIdOf: (root) => bundleIds.get(root),
      });
    }).pipe(
      Effect.tap((roots) =>
        roots.length === 0
          ? logTakeoverInfo("no other installation holds the service; taking over silently")
          : logTakeoverWarning("other installation holds the service", { roots }),
      ),
      Effect.tapError((error) =>
        logTakeoverWarning("other-installation detection failed", { error: String(error) }),
      ),
    );
    return DesktopServiceTakeover.of({
      confirm: makeTakeoverGate({ detect, awaitTakeover: desktopWindow.awaitServiceTakeover }),
    });
  }),
);
