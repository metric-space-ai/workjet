// @effect-diagnostics nodeBuiltinImport:off -- isolated archive and executable-metadata fixtures.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { managedNodeArchive } from "../../packages/ssh/src/remoteNode.ts";
import { preparePortableNode, stageVerifiedNodeArchive } from "./prepare-portable-node.ts";

async function fixture(
  run: (input: Parameters<typeof stageVerifiedNodeArchive>[0], root: string) => Promise<void>,
  identity: object = {
    version: "24.13.1",
    platform: process.platform,
    arch: process.arch,
    electron: null,
  },
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workjet-portable-node-test-"));
  try {
    const pin = managedNodeArchive(process.platform, process.arch);
    const source = path.join(root, pin.directoryName);
    await fs.mkdir(path.join(source, "bin"), { recursive: true });
    // This fixture models the metadata protocol, not a real Node runtime.
    await fs.writeFile(
      path.join(source, "bin", "node"),
      `#!/bin/sh\ncat <<'IDENTITY'\n${JSON.stringify(identity)}\nIDENTITY\n`,
      { mode: 0o755 },
    );
    await fs.writeFile(path.join(source, "LICENSE"), "Fixture notice\n");
    const archivePath = path.join(root, "node.tar.gz");
    execFileSync("tar", ["-czf", archivePath, "-C", root, pin.directoryName], { timeout: 10_000 });
    const sha256 = createHash("sha256")
      .update(await fs.readFile(archivePath))
      .digest("hex");
    await run(
      { archivePath, destination: path.join(root, "installed"), pin: { ...pin, sha256 } },
      root,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("portable standalone Node packaging", () => {
  it("verifies and stages an isolated archive with its license and release receipt", async () => {
    await fixture(async (input, root) => {
      const executable = await stageVerifiedNodeArchive(input);
      expect(executable).toBe(path.join(input.destination, "bin", "node"));
      expect(await fs.readFile(executable, "utf8")).toContain("IDENTITY");
      expect(await fs.readFile(path.join(input.destination, "LICENSE"), "utf8")).toBe(
        "Fixture notice\n",
      );
      expect(
        JSON.parse(await fs.readFile(path.join(input.destination, "workjet-runtime.json"), "utf8")),
      ).toEqual(input.pin);
      expect((await fs.readdir(root)).some((entry) => entry.startsWith(".node-stage-"))).toBe(
        false,
      );
    });
  });

  it("rejects corrupted bytes before creating an extraction stage", async () => {
    await fixture(async (input, root) => {
      await fs.appendFile(input.archivePath, "corrupt");
      await expect(stageVerifiedNodeArchive(input)).rejects.toThrow("checksum verification failed");
      await expect(fs.access(input.destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(root)).some((entry) => entry.startsWith(".node-stage-"))).toBe(
        false,
      );
    });
  });

  it.each([
    { version: "0.0.0", platform: process.platform, arch: process.arch, electron: null },
    { version: "24.13.1", platform: "wrong-os", arch: process.arch, electron: null },
    { version: "24.13.1", platform: process.platform, arch: "wrong-arch", electron: null },
    { version: "24.13.1", platform: process.platform, arch: process.arch, electron: "40" },
  ])("refuses a mismatched executable identity %j", async (identity) => {
    await fixture(async (input, root) => {
      await expect(stageVerifiedNodeArchive(input)).rejects.toThrow("identity does not match");
      await expect(fs.access(input.destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(root)).some((entry) => entry.startsWith(".node-stage-"))).toBe(
        false,
      );
    }, identity);
  });

  it("preserves an existing destination rather than replacing its executable", async () => {
    await fixture(async (input) => {
      await fs.mkdir(input.destination);
      await fs.writeFile(path.join(input.destination, "keep"), "previous artifact");
      await expect(stageVerifiedNodeArchive(input)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await fs.readdir(input.destination)).toEqual(["keep"]);
      expect(await fs.readFile(path.join(input.destination, "keep"), "utf8")).toBe(
        "previous artifact",
      );
    });
  });

  it("removes a corrupt download and leaves no executable behind", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workjet-node-download-test-"));
    const download = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("corrupt"));
    try {
      await expect(
        preparePortableNode({
          destination: path.join(root, "node"),
          platform: process.platform,
          arch: process.arch,
        }),
      ).rejects.toThrow("checksum verification failed");
      expect(await fs.readdir(root)).toEqual([]);
      expect(download).toHaveBeenCalledOnce();
    } finally {
      download.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
