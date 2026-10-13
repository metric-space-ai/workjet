// oxlint-disable workjet/no-global-process-runtime -- Isolated packaged smoke process inventory and cleanup boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { promisify } from "node:util";

const execFile = promisify(NodeChildProcess.execFile);
const PROCESS_OPTIONS = { encoding: "utf8" as const, timeout: 5000, maxBuffer: 16 * 1024 * 1024 };

export interface SmokeProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

export interface SmokeSurvivor {
  readonly pid: number;
  readonly ppid: number;
  readonly matchedBy: readonly ("argv" | "cwd")[];
}

export interface SmokeProcessInspection {
  readonly survivorCount: number;
  readonly survivors: readonly SmokeSurvivor[];
  readonly observedProcessCount: number;
}

export function parseSmokeProcesses(table: string): SmokeProcess[] {
  return table.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
  });
}

export function parseSmokeWorkingDirectories(table: string): Map<number, string> {
  const result = new Map<number, string>();
  let pid: number | undefined;
  for (const line of table.split("\n")) {
    if (/^p\d+$/u.test(line)) pid = Number(line.slice(1));
    else if (pid !== undefined && line.startsWith("n")) result.set(pid, line.slice(1));
  }
  return result;
}

export function findSmokeSurvivors(
  roots: readonly string[],
  processes: readonly SmokeProcess[],
  directories: ReadonlyMap<number, string>,
  observerPid: number,
): SmokeProcessInspection {
  const patterns = roots.map((root) => {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?:^|[\\s="'])${escaped}(?=$|[/\\s"'])`, "u");
  });
  const survivors = processes.flatMap((entry): SmokeSurvivor[] => {
    if (entry.pid === observerPid) return [];
    const matchedBy: ("argv" | "cwd")[] = [];
    if (patterns.some((pattern) => pattern.test(entry.command))) matchedBy.push("argv");
    const cwd = directories.get(entry.pid);
    if (
      cwd !== undefined &&
      roots.some((root) => {
        const relative = NodePath.relative(root, cwd);
        return relative === "" || (relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative));
      })
    ) matchedBy.push("cwd");
    return matchedBy.length ? [{ pid: entry.pid, ppid: entry.ppid, matchedBy }] : [];
  });
  return { survivorCount: survivors.length, survivors, observedProcessCount: processes.length };
}

export async function inspectSmokeRootProcesses(root: string): Promise<SmokeProcessInspection> {
  const roots = [...new Set([NodePath.resolve(root), await NodeFSP.realpath(root)])];
  const { stdout } = await execFile("ps", ["-ax", "-o", "pid=,ppid=,args="], PROCESS_OPTIONS);
  const processes = parseSmokeProcesses(stdout);
  if (!processes.length) throw new Error("Smoke process inventory is empty");
  let directories: Map<number, string>;
  if (NodeOS.platform() === "darwin") {
    const cwd = await execFile("lsof", ["-n", "-w", "-a", "-d", "cwd", "-Fpn"], PROCESS_OPTIONS);
    directories = parseSmokeWorkingDirectories(cwd.stdout);
  } else if (NodeOS.platform() === "linux") {
    directories = new Map();
    for (const entry of processes) {
      try {
        directories.set(entry.pid, await NodeFSP.readlink(`/proc/${entry.pid}/cwd`));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(code ?? '')) throw error;
      }
    }
  } else {
    throw new Error("Smoke process inventory requires macOS or Linux");
  }
  return findSmokeSurvivors(roots, processes, directories, process.pid);
}

export const SMOKE_ROOT_REMOVAL_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
} as const;

export async function removeStoppedSmokeRoot(root: string, inspection: SmokeProcessInspection) {
  if (inspection.survivorCount > 0) throw new Error("Smoke root still has surviving processes");
  await NodeFSP.rm(root, SMOKE_ROOT_REMOVAL_OPTIONS);
}
