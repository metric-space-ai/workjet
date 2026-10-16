import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  findOtherInstallations,
  installationRootOf,
  makeTakeoverGate,
  parseBundleIdentifier,
  parseProcessTable,
} from "./DesktopServiceTakeover.ts";

vi.mock("electron", () => ({ safeStorage: {} }));

const OWN = "/Applications/Workjet.app/Contents/MacOS/Workjet";
const OTHER = "/Users/a/Downloads/Workjet 2.app/Contents/MacOS/Workjet";
const own = [
  { pid: 500, ppid: 1, executable: OWN },
  {
    pid: 501,
    ppid: 500,
    executable:
      "/Applications/Workjet.app/Contents/Frameworks/Workjet Helper (GPU).app/Contents/MacOS/Workjet Helper (GPU)",
  },
  { pid: 502, ppid: 500, executable: OWN },
  { pid: 503, ppid: 502, executable: OWN },
];

it("parses the process table including executables with spaces", () => {
  assert.deepEqual(parseProcessTable(`  500     1 ${OWN}\n  700 1 ${OTHER}\ngarbage\n`), [
    { pid: 500, ppid: 1, executable: OWN },
    { pid: 700, ppid: 1, executable: OTHER },
  ]);
  assert.equal(installationRootOf(OTHER), "/Users/a/Downloads/Workjet 2.app");
  assert.equal(installationRootOf("/opt/Workjet/workjet"), "/opt/Workjet");
});

it("own process, its children and the exiting predecessor after an update are not other installations", () => {
  assert.deepEqual(
    findOtherInstallations({
      ownPid: 500,
      ownExecutable: OWN,
      processes: [{ pid: 400, ppid: 1, executable: OWN }, ...own],
      lockHolderPids: [400, 502],
    }),
    [],
  );
});

it("another running installation of the same app is detected", () => {
  const ids: Record<string, string> = {
    "/Applications/Workjet.app": "dev.workjet.app",
    "/Users/a/Downloads/Workjet 2.app": "dev.workjet.app",
    "/Applications/Other.app": "com.example.other",
  };
  assert.deepEqual(
    findOtherInstallations({
      ownPid: 500,
      ownExecutable: OWN,
      processes: [
        ...own,
        { pid: 700, ppid: 1, executable: OTHER },
        { pid: 701, ppid: 1, executable: "/Applications/Other.app/Contents/MacOS/Workjet" },
        { pid: 702, ppid: 1, executable: "/usr/bin/ssh" },
      ],
      bundleIdOf: (root) => ids[root],
    }),
    ["/Users/a/Downloads/Workjet 2.app"],
  );
  // A renamed bundle that holds the profile lock counts even without a readable identity.
  assert.deepEqual(
    findOtherInstallations({
      ownPid: 500,
      ownExecutable: OWN,
      processes: [
        ...own,
        { pid: 800, ppid: 1, executable: "/Volumes/X/Beta.app/Contents/MacOS/Beta" },
      ],
      lockHolderPids: [800],
      bundleIdOf: (root) => ids[root],
    }),
    ["/Volumes/X/Beta.app"],
  );
});

it("reads the bundle identifier from an XML Info.plist", () => {
  assert.equal(
    parseBundleIdentifier(
      "<dict>\n<key>CFBundleIdentifier</key>\n\t<string>dev.workjet.app</string>\n</dict>",
    ),
    "dev.workjet.app",
  );
  assert.isUndefined(parseBundleIdentifier("bplist00"));
});

it.effect("the gate is silent without another installation and shows the line otherwise", () =>
  Effect.gen(function* () {
    let lines = 0;
    const awaitTakeover = Effect.sync(() => {
      lines++;
      return true;
    });
    assert.isTrue(yield* makeTakeoverGate({ detect: Effect.succeed([]), awaitTakeover }));
    assert.equal(lines, 0);
    assert.isTrue(
      yield* makeTakeoverGate({ detect: Effect.succeed(["/Other.app"]), awaitTakeover }),
    );
    assert.equal(lines, 1);
    // A failed detection never takes over silently.
    yield* makeTakeoverGate({ detect: Effect.fail("ps failed"), awaitTakeover });
    assert.equal(lines, 2);
    assert.isFalse(
      yield* makeTakeoverGate({
        detect: Effect.succeed(["/Other.app"]),
        awaitTakeover: Effect.succeed(false),
      }),
    );
  }),
);
