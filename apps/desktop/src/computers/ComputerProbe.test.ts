// @effect-diagnostics globalDate:off -- Wall-clock upper bound verifies a child-process deadline.
import { describe, expect, it } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off -- Probe execution uses only a throwaway HOME.
import * as Fsp from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import * as Child from "node:child_process";
import { promisify } from "node:util";
import { COMPUTER_PROBE_SCRIPT } from "./ComputerProbe.ts";
const execFile = promisify(Child.execFile);
import { deriveComputerCapacity, parseComputerProbe } from "./ComputerProbe.ts";
const linux =
  "os=Linux\narch=x86_64\nhome=/home/test\nroot=/home/test/.workjet/computer-work\ncores=16\nram=34359738368\nfree_kib=50000000\nmachine=machine-a\ntool.rustc=rustc 1.0\ncoding.codex=codex-cli 1.0\n";
describe("computer facts", () => {
  it("detects Linux versions and derives all CPUs and one build", () => {
    const facts = parseComputerProbe(
      linux + "gpu=NVIDIA RTX A4500, 20480\n",
      "",
      "2026-10-11T00:00:00Z",
    );
    expect(facts.gpus[0]).toEqual({
      model: "NVIDIA RTX A4500",
      vramBytes: 20480 * 1024 ** 2,
      unifiedMemory: false,
    });
    expect(facts.toolchains.rustc).toBe("rustc 1.0");
    expect(facts.checkedAt).toBe("2026-10-11T00:00:00Z");
    expect(deriveComputerCapacity(facts)).toMatchObject({
      concurrentBuilds: 1,
      workersPerBuild: 16,
      useGpu: true,
      enoughFreeSpace: true,
    });
  });
  it("keeps no GPU empty and records unavailable tools instead of inventing them", () => {
    const facts = parseComputerProbe(linux, "warning=podman timed out or unavailable\n");
    expect(facts.gpus).toEqual([]);
    expect(facts.toolchains.podman).toBeUndefined();
    expect(facts.warnings).toHaveLength(1);
  });
  it("reports Apple unified memory without inventing dedicated VRAM", () => {
    const facts = parseComputerProbe(
      linux.replace("os=Linux", "os=Darwin") +
        'apple_gpu={"SPDisplaysDataType":[{"sppci_model":"Apple M3"}]}\n',
    );
    expect(facts.gpus).toEqual([{ model: "Apple M3", vramBytes: null, unifiedMemory: true }]);
  });
  it("rejects incomplete probes rather than saving guessed CPU capacity", () => {
    expect(() => parseComputerProbe("os=Linux\n")).toThrow();
  });
});

it("executes detection in a disposable HOME and bounds a tool that ignores TERM", async () => {
  const home = await Fsp.mkdtemp(Path.join(Os.tmpdir(), "workjet-probe-fixture-"));
  try {
    const bin = Path.join(home, "bin");
    await Fsp.mkdir(bin);
    await Fsp.writeFile(Path.join(bin, "rustc"), "#!/bin/sh\ntrap '' TERM\nsleep 60 &\nwait\n", {
      mode: 0o755,
    });
    const started = Date.now();
    const { stdout, stderr } = await execFile("sh", ["-c", COMPUTER_PROBE_SCRIPT], {
      timeout: 15000,
      env: { ...process.env, HOME: home, PATH: bin + ":/usr/bin:/bin" },
    });
    const facts = parseComputerProbe(stdout, stderr);
    expect(facts.homeDirectory).toBe(home);
    expect(facts.workDirectory).toBe(Path.join(home, ".workjet/computer-work"));
    expect(facts.cpuCores).toBeGreaterThan(0);
    expect(facts.toolchains.rustc).toBeUndefined();
    expect(facts.warnings.some((warning) => warning.includes("rustc"))).toBe(true);
    expect(Date.now() - started).toBeLessThan(12000);
  } finally {
    await Fsp.rm(home, { recursive: true, force: true });
  }
}, 20000);
