// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Captured native process fixture and evidence.
// oxlint-disable workjet/no-global-process-runtime -- Captured synthetic smoke processes, never the installed App.
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  findSmokeSurvivors,
  inspectSmokeRootProcesses,
  parseSmokeProcesses,
  parseSmokeWorkingDirectories,
  removeStoppedSmokeRoot,
} from "./packaged-startup-cleanup.ts";

const writer = `const fs=require('node:fs');const path=require('node:path');
fs.mkdirSync('home/userdata/logs',{recursive:true});
setInterval(()=>fs.writeFileSync(path.resolve('home/userdata/logs/heartbeat'),String(Date.now())),20);`;

describe("packaged startup process inventory", () => {
  it("parses cwd names with spaces without exposing commands in the report", () => {
    const processes = parseSmokeProcesses(
      " 101 1 node --home=/tmp/profile\n102 1 node --token=secret\n",
    );
    const cwd = parseSmokeWorkingDirectories("p102\nn/tmp/profile/home with spaces\n");
    const report = findSmokeSurvivors(["/tmp/profile"], processes, cwd, 999);
    expect(report.survivorCount).toBe(2);
    expect(report.survivors).toEqual([
      { pid: 101, ppid: 1, matchedBy: ["argv"] },
      { pid: 102, ppid: 1, matchedBy: ["cwd"] },
    ]);
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("matches canonical macOS paths, excludes the observer and similarly named roots", () => {
    const rows = [
      { pid: 1, ppid: 0, command: "node --home=/tmp/profile-other" },
      { pid: 2, ppid: 0, command: "node --home=/tmp/profile/home" },
      { pid: 3, ppid: 0, command: "node" },
      { pid: 4, ppid: 0, command: "node --home=/tmp/profile" },
    ];
    const result = findSmokeSurvivors(
      ["/tmp/profile", "/private/tmp/profile"],
      rows,
      new Map([[3, "/private/tmp/profile/home"]]),
      4,
    );
    expect(result.survivors.map((row) => row.pid)).toEqual([2, 3]);
  });

  it("escapes special characters and includes cwd-only children with dot prefixes", () => {
    const roots = ["/tmp/profile.[1]"];
    expect(
      findSmokeSurvivors(
        roots,
        [{ pid: 1, ppid: 0, command: "node --home=/tmp/profile.[1]/home" }],
        new Map(),
        99,
      ).survivorCount,
    ).toBe(1);
    expect(
      findSmokeSurvivors(
        roots,
        [{ pid: 2, ppid: 0, command: "node" }],
        new Map([[2, "/tmp/profile.[1]/..logs"]]),
        99,
      ).survivorCount,
    ).toBe(1);
  });

  it("finds a real setsid escape after the captured parent process group is stopped", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-smoke-leak-test-"));
    let escapedPid: number | undefined;
    const parentCode = `const cp=require('node:child_process');
const child=cp.spawn(process.execPath,['-e',${JSON.stringify(writer)}],{cwd:process.cwd(),detached:true,stdio:'ignore'});
console.log(child.pid);setInterval(()=>{},1000);`;
    const parent = NodeChildProcess.spawn(process.execPath, ["-e", parentCode], {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parentClosed = new Promise<void>((resolve) => parent.once("close", () => resolve()));
    try {
      const data = await new Promise<Buffer>((resolve) => parent.stdout!.once("data", resolve));
      escapedPid = Number(String(data).trim());
      expect(Number.isSafeInteger(escapedPid)).toBe(true);
      expect(escapedPid).toBeGreaterThan(0);
      process.kill(-parent.pid!, "SIGTERM");
      await parentClosed;
      try {
        process.kill(-parent.pid!, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const inspection = await inspectSmokeRootProcesses(root);
      expect(inspection.survivors).toContainEqual(
        expect.objectContaining({ pid: escapedPid, matchedBy: ["cwd"] }),
      );
      await expect(removeStoppedSmokeRoot(root, inspection)).rejects.toThrow("surviving processes");
      expect((await NodeFSP.stat(root)).isDirectory()).toBe(true);
      console.log(
        JSON.stringify({
          scenario: "setsid writer after parent SIGTERM/SIGKILL",
          survivorCount: inspection.survivorCount,
          survivors: inspection.survivors,
          rootRetained: true,
        }),
      );
    } finally {
      // Both IDs originate from this test's own spawn, not an inventory match.
      if (escapedPid !== undefined) {
        try {
          process.kill(escapedPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      await parentClosed;
      await NodeFSP.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("removes an actually stopped profile after a successful process inventory", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "workjet-smoke-stopped-test-"),
    );
    await NodeFSP.mkdir(NodePath.join(root, "home/userdata/logs"), { recursive: true });
    const inspection = await inspectSmokeRootProcesses(root);
    expect(inspection.survivorCount).toBe(0);
    await removeStoppedSmokeRoot(root, inspection);
    await expect(NodeFSP.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
