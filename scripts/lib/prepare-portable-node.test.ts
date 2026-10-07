// @effect-diagnostics nodeBuiltinImport:off -- isolated archive and executable-metadata fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Context from "effect/Context";
import { HostProcessPlatform, HostProcessArchitecture } from "@workjet/shared/hostProcess";
import * as RemoteNode from "@workjet/ssh/remoteNode";
import { preparePortableNode, stageVerifiedNodeArchive } from "./prepare-portable-node.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof NodeChildProcess>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

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
  paddingBytes: number = 0,
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-portable-node-test-"));
  try {
    const pin = RemoteNode.managedNodeArchive(hostPlatform, hostArchitecture);
    const source = NodePath.join(root, pin.directoryName);
    await NodeFSP.mkdir(NodePath.join(source, "bin"), { recursive: true });
    // This fixture models the metadata protocol, not a real Node runtime.
    await NodeFSP.writeFile(
      NodePath.join(source, "bin", "node"),
      `#!/bin/sh\ntest ! -e "$(dirname "$0")/../include" || exit 98\ntest ! -e "$(dirname "$0")/../share" || exit 98\ncat <<'IDENTITY'\n${JSON.stringify(identity)}\nIDENTITY\n`,
      { mode: 0o755 },
    );
    await NodeFSP.writeFile(NodePath.join(source, "LICENSE"), "Fixture notice\n");
    for (const entry of ["include/node", "share/man", "lib/node_modules/npm"]) {
      await NodeFSP.mkdir(NodePath.join(source, entry), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(source, entry, "fixture"), entry);
    }
    if (paddingBytes > 0)
      await NodeFSP.writeFile(
        NodePath.join(source, "padding"),
        NodeCrypto.randomBytes(paddingBytes),
      );
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
  let archiveCache: string;
  beforeAll(async () => {
    archiveCache = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "workjet-node-cache-test-"),
    );
    vi.stubGlobal("fetch", download);
  });
  beforeEach(async () => {
    await NodeFSP.rm(archiveCache, { recursive: true, force: true });
    await NodeFSP.mkdir(archiveCache);
    download.mockReset();
    download.mockRejectedValue(new Error("Unexpected portable Node network request"));
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await NodeFSP.rm(archiveCache, { recursive: true, force: true });
  });

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

  it("bounds a stalled identity probe, redacts child diagnostics and cleans its stage", async () => {
    await fixture(async (input, root) => {
      const execute = vi
        .mocked(NodeChildProcess.execFile)
        .mockImplementationOnce((_file, _arguments, _options, callback) => {
          callback!(
            Object.assign(new Error("PRIVATE child command"), {
              code: "ETIMEDOUT",
              signal: "SIGKILL" as const,
              killed: true,
            }),
            "PRIVATE stdout",
            "PRIVATE stderr",
          );
          return new NodeChildProcess.ChildProcess();
        });
      try {
        const failure = await stageVerifiedNodeArchive(input).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(
          /identity verification failed \(180000ms deadline; elapsed \d+ms; code ETIMEDOUT; signal SIGKILL\)/,
        );
        expect((failure as Error).message).not.toContain("PRIVATE");
        expect((failure as Error).cause).toBeUndefined();
        expect(execute.mock.calls[0]?.[2]).toMatchObject({
          timeout: 180_000,
          killSignal: "SIGKILL",
          env: expect.objectContaining({ NODE_OPTIONS: "", NODE_PATH: "" }),
        });
        await expect(NodeFSP.access(input.destination)).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          (await NodeFSP.readdir(root)).some((entry) => entry.startsWith(".node-stage-")),
        ).toBe(false);
      } finally {
        execute.mockImplementation(
          (await vi.importActual<typeof NodeChildProcess>("node:child_process")).execFile,
        );
        execute.mockClear();
      }
    });
  });

  it("downloads a valid archive in tiny chunks and preserves full buffers plus the final tail", async () => {
    await fixture(
      async (input, root) => {
        const pin = vi.spyOn(RemoteNode, "managedNodeArchive").mockReturnValue(input.pin);
        try {
          const bytes = await NodeFSP.readFile(input.archivePath);
          expect(bytes.byteLength).toBeGreaterThan(2 * 1024 * 1024);
          let offset = 0;
          download.mockResolvedValue(
            new Response(
              new ReadableStream({
                pull(controller) {
                  if (offset === bytes.byteLength) {
                    controller.close();
                    return;
                  }
                  const width = offset < 8192 ? 137 : 2053;
                  const end = Math.min(offset + width, bytes.byteLength);
                  controller.enqueue(bytes.subarray(offset, end));
                  offset = end;
                },
              }),
            ),
          );
          const executable = await preparePortableNode({
            destination: input.destination,
            platform: hostPlatform,
            arch: hostArchitecture,
            archiveCacheDirectory: archiveCache,
          });
          expect(await NodeFSP.readFile(executable, "utf8")).toContain("IDENTITY");
          expect(await NodeFSP.readFile(NodePath.join(input.destination, "padding"))).toEqual(
            await NodeFSP.readFile(NodePath.join(root, input.pin.directoryName, "padding")),
          );
          expect(await NodeFSP.readFile(NodePath.join(input.destination, "LICENSE"), "utf8")).toBe(
            "Fixture notice\n",
          );
          expect(
            (await NodeFSP.readdir(root)).some(
              (entry) => entry.startsWith(".node-download-") || entry.startsWith(".node-stage-"),
            ),
          ).toBe(false);
          expect(download).toHaveBeenCalledOnce();
          download.mockRejectedValue(new Error("Second package stage is offline"));
          const secondDestination = NodePath.join(root, "second-stage");
          const secondExecutable = await preparePortableNode({
            destination: secondDestination,
            platform: hostPlatform,
            arch: hostArchitecture,
            archiveCacheDirectory: archiveCache,
          });
          expect(await NodeFSP.readFile(secondExecutable, "utf8")).toContain("IDENTITY");
          expect(await NodeFSP.readFile(NodePath.join(secondDestination, "LICENSE"), "utf8")).toBe(
            "Fixture notice\n",
          );
          expect(
            JSON.parse(
              await NodeFSP.readFile(
                NodePath.join(secondDestination, "workjet-runtime.json"),
                "utf8",
              ),
            ),
          ).toEqual(input.pin);
          expect(download).toHaveBeenCalledOnce();
          const cachedArchive = NodePath.join(
            archiveCache,
            `${input.pin.directoryName}-${input.pin.sha256}.tar.gz`,
          );
          expect(await NodeFSP.readFile(cachedArchive)).toEqual(bytes);
          await NodeFSP.appendFile(cachedArchive, "corrupt");
          const refusedDestination = NodePath.join(root, "refused-stage");
          await expect(
            preparePortableNode({
              destination: refusedDestination,
              platform: hostPlatform,
              arch: hostArchitecture,
              archiveCacheDirectory: archiveCache,
            }),
          ).rejects.toThrow("checksum verification failed");
          await expect(NodeFSP.access(refusedDestination)).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(download).toHaveBeenCalledOnce();
          expect(await NodeFSP.readdir(archiveCache)).toEqual([NodePath.basename(cachedArchive)]);
        } finally {
          pin.mockRestore();
        }
      },
      undefined,
      2 * 1024 * 1024 + 8191,
    );
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
          archiveCacheDirectory: archiveCache,
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
          archiveCacheDirectory: archiveCache,
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
        archiveCacheDirectory: archiveCache,
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
          archiveCacheDirectory: archiveCache,
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
          archiveCacheDirectory: archiveCache,
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
