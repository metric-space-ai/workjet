// @effect-diagnostics nodeBuiltinImport:off -- isolated archive and executable-metadata fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Context from "effect/Context";
import { HostProcessPlatform, HostProcessArchitecture } from "@workjet/shared/hostProcess";
import { managedNodeArchive } from "@workjet/ssh/remoteNode";
import { preparePortableNode, stageVerifiedNodeArchive } from "./prepare-portable-node.ts";

const hostContext = Context.empty();
const hostPlatform = Context.get(hostContext, HostProcessPlatform);
const hostArchitecture = Context.get(hostContext, HostProcessArchitecture);

async function fixture(
  run: (input: Parameters<typeof stageVerifiedNodeArchive>[0], root: string) => Promise<void>,
  identity: object = {
    version: "24.13.1",
    platform: hostPlatform,
    arch: hostArchitecture,
    electron: null,
  },
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-portable-node-test-"));
  try {
    const pin = managedNodeArchive(hostPlatform, hostArchitecture);
    const source = NodePath.join(root, pin.directoryName);
    await NodeFSP.mkdir(NodePath.join(source, "bin"), { recursive: true });
    // This fixture models the metadata protocol, not a real Node runtime.
    await NodeFSP.writeFile(
      NodePath.join(source, "bin", "node"),
      `#!/bin/sh\ncat <<'IDENTITY'\n${JSON.stringify(identity)}\nIDENTITY\n`,
      { mode: 0o755 },
    );
    await NodeFSP.writeFile(NodePath.join(source, "LICENSE"), "Fixture notice\n");
    for (const entry of ["include/node", "share/man", "lib/node_modules/npm"]) {
      await NodeFSP.mkdir(NodePath.join(source, entry), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(source, entry, "fixture"), entry);
    }
    const archivePath = NodePath.join(root, "node.tar.gz");
    NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, pin.directoryName], {
      timeout: 10_000,
    });
    const sha256 = NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(archivePath))
      .digest("hex");
    await run(
      { archivePath, destination: NodePath.join(root, "installed"), pin: { ...pin, sha256 } },
      root,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(hostPlatform === "win32")("portable standalone Node packaging", () => {
  // Effect caches the Fetch reference's default. Keep one mock identity for the
  // whole suite so later cases cannot fall through a restored spy to the network.
  const download = vi.fn<typeof fetch>();
  beforeAll(() => vi.stubGlobal("fetch", download));
  beforeEach(() => {
    download.mockReset();
    download.mockRejectedValue(new Error("Unexpected portable Node network request"));
  });
  afterAll(() => vi.unstubAllGlobals());

  it("verifies and stages an isolated archive with its license and release receipt", async () => {
    await fixture(async (input, root) => {
      const executable = await stageVerifiedNodeArchive(input);
      expect(executable).toBe(NodePath.join(input.destination, "bin", "node"));
      expect(await NodeFSP.readFile(executable, "utf8")).toContain("IDENTITY");
      expect(await NodeFSP.readFile(NodePath.join(input.destination, "LICENSE"), "utf8")).toBe(
        "Fixture notice\n",
      );
      expect(
        JSON.parse(
          await NodeFSP.readFile(NodePath.join(input.destination, "workjet-runtime.json"), "utf8"),
        ),
      ).toEqual(input.pin);
      expect(
        await NodeFSP.readFile(
          NodePath.join(input.destination, "lib/node_modules/npm/fixture"),
          "utf8",
        ),
      ).toBe("lib/node_modules/npm");
      for (const entry of ["include", "share"]) {
        await expect(NodeFSP.access(NodePath.join(input.destination, entry))).rejects.toMatchObject(
          { code: "ENOENT" },
        );
      }
      expect((await NodeFSP.readdir(root)).some((entry) => entry.startsWith(".node-stage-"))).toBe(
        false,
      );
    });
  });

  it("rejects corrupted bytes before creating an extraction stage", async () => {
    await fixture(async (input, root) => {
      await NodeFSP.appendFile(input.archivePath, "corrupt");
      await expect(stageVerifiedNodeArchive(input)).rejects.toThrow("checksum verification failed");
      await expect(NodeFSP.access(input.destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await NodeFSP.readdir(root)).some((entry) => entry.startsWith(".node-stage-"))).toBe(
        false,
      );
    });
  });

  it.each([
    { version: "0.0.0", platform: hostPlatform, arch: hostArchitecture, electron: null },
    { version: "24.13.1", platform: "wrong-os", arch: hostArchitecture, electron: null },
    { version: "24.13.1", platform: hostPlatform, arch: "wrong-arch", electron: null },
    { version: "24.13.1", platform: hostPlatform, arch: hostArchitecture, electron: "40" },
  ])("refuses a mismatched executable identity %j", async (identity) => {
    await fixture(async (input, root) => {
      await expect(stageVerifiedNodeArchive(input)).rejects.toThrow("identity does not match");
      await expect(NodeFSP.access(input.destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await NodeFSP.readdir(root)).some((entry) => entry.startsWith(".node-stage-"))).toBe(
        false,
      );
    }, identity);
  });

  it("preserves an existing destination rather than replacing its executable", async () => {
    await fixture(async (input) => {
      await NodeFSP.mkdir(input.destination);
      await NodeFSP.writeFile(NodePath.join(input.destination, "keep"), "previous artifact");
      await expect(stageVerifiedNodeArchive(input)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await NodeFSP.readdir(input.destination)).toEqual(["keep"]);
      expect(await NodeFSP.readFile(NodePath.join(input.destination, "keep"), "utf8")).toBe(
        "previous artifact",
      );
    });
  });

  it("removes a corrupt download and leaves no executable behind", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "workjet-node-download-test-"),
    );
    download.mockResolvedValue(new Response("corrupt"));
    try {
      await expect(
        preparePortableNode({
          destination: NodePath.join(root, "node"),
          platform: hostPlatform,
          arch: hostArchitecture,
        }),
      ).rejects.toThrow("checksum verification failed");
      expect(await NodeFSP.readdir(root)).toEqual([]);
      expect(download).toHaveBeenCalledOnce();
      expect(download.mock.calls[0]?.[1]?.redirect).toBe("error");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("reports a transport failure with its pinned target and removes its private stage", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "workjet-node-transport-test-"),
    );
    download.mockRejectedValue(new Error("simulated offline transport"));
    try {
      await expect(
        preparePortableNode({
          destination: NodePath.join(root, "node"),
          platform: hostPlatform,
          arch: hostArchitecture,
        }),
      ).rejects.toThrow(
        /Could not download pinned portable Node .* from https:\/\/nodejs\.org\/.*\(0 bytes received\)/,
      );
      expect(await NodeFSP.readdir(root)).toEqual([]);
      expect(download).toHaveBeenCalledOnce();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("cancels a stalled download at its deadline and leaves no partial stage", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "workjet-node-timeout-test-"),
    );
    let cancelled = false;
    download.mockImplementation(
      (_request, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    vi.useFakeTimers();
    try {
      const pending = preparePortableNode({
        destination: NodePath.join(root, "node"),
        platform: hostPlatform,
        arch: hostArchitecture,
      });
      const rejected = expect(pending).rejects.toThrow(/0 bytes received.*TimeoutError/);
      await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(180_001);
      await rejected;
      expect(cancelled).toBe(true);
      expect(await NodeFSP.readdir(root)).toEqual([]);
    } finally {
      vi.useRealTimers();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unsuccessful HTTP response and cleans its download stage", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-node-http-test-"));
    download.mockResolvedValue(new Response("unavailable", { status: 503 }));
    try {
      await expect(
        preparePortableNode({
          destination: NodePath.join(root, "node"),
          platform: hostPlatform,
          arch: hostArchitecture,
        }),
      ).rejects.toThrow("Portable Node download failed (503)");
      expect(await NodeFSP.readdir(root)).toEqual([]);
      expect(download).toHaveBeenCalledOnce();
      expect(download.mock.calls[0]?.[1]?.redirect).toBe("error");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("cancels an oversized streamed archive and removes the partial download", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-node-limit-test-"));
    const chunk = new Uint8Array(1024 * 1024);
    let cancelled = false;
    let remainingChunks = 104;
    download.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (remainingChunks-- > 0) controller.enqueue(chunk);
            else controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    try {
      await expect(
        preparePortableNode({
          destination: NodePath.join(root, "node"),
          platform: hostPlatform,
          arch: hostArchitecture,
        }),
      ).rejects.toThrow("size limit");
      expect(cancelled).toBe(true);
      expect(await NodeFSP.readdir(root)).toEqual([]);
      expect(download).toHaveBeenCalledOnce();
      expect(download.mock.calls[0]?.[1]?.redirect).toBe("error");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
