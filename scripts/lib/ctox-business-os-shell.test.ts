// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Tests build tiny byte-level gzip/USTAR fixtures and coordinate concurrent publishers.

import { createHash } from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOs from "node:os";
import { gzipSync } from "node:zlib";

import { assert, it } from "@effect/vitest";

import {
  CTOX_BUSINESS_OS_SHELL_ARCHIVE_URL,
  CTOX_BUSINESS_OS_SHELL_COMPLETION_SENTINEL,
  CTOX_BUSINESS_OS_SHELL_EMBEDDED_MANIFEST,
  CTOX_BUSINESS_OS_SHELL_MANIFEST_URL,
  CTOX_BUSINESS_OS_SHELL_SCHEMA,
  CtoxBusinessOsShellError,
  type CtoxBusinessOsShellFetch,
  type CtoxBusinessOsShellReleaseManifest,
  prepareCtoxBusinessOsShellForTest,
  resolveCtoxBusinessOsShellDependencyRoot,
  verifyCtoxBusinessOsShellInstall,
} from "./ctox-business-os-shell.ts";

const VERSION = "0.1.0-rc.10";
const SOURCE_COMMIT = "203699e600901ba69cf0afc20f49192688e2dad3";
const ARCHIVE_ROOT = `ctox-business-os-shell-${VERSION}`;
const ARCHIVE_FILENAME = `${ARCHIVE_ROOT}.tar.gz`;

interface InventoryRecord {
  readonly path: string;
  readonly byteSize: number;
  readonly sha256: string;
}

interface TarFixtureEntry {
  readonly path: string;
  readonly typeByte: number;
  readonly data?: Buffer;
  readonly linkName?: string;
}

interface Fixture {
  readonly archive: Buffer;
  readonly detachedManifest: Buffer;
  readonly release: CtoxBusinessOsShellReleaseManifest;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function writeString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value);
  assert.isAtMost(bytes.length, length);
  bytes.copy(header, offset);
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  writeString(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarHeader(entry: TarFixtureEntry): Buffer {
  const header = Buffer.alloc(512);
  const isDirectory = entry.typeByte === 0x35;
  const archivePath = isDirectory && !entry.path.endsWith("/") ? `${entry.path}/` : entry.path;
  writeString(header, 0, 100, archivePath);
  writeOctal(header, 100, 8, isDirectory ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.data?.length ?? 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.typeByte;
  if (entry.linkName !== undefined) writeString(header, 157, 100, entry.linkName);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function tar(entries: ReadonlyArray<TarFixtureEntry>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry));
    const data = entry.data ?? Buffer.alloc(0);
    if (data.length > 0) chunks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function inventory(files: Readonly<Record<string, Buffer>>): ReadonlyArray<InventoryRecord> {
  return Object.entries(files)
    .map(([path, data]) => ({ path, byteSize: data.length, sha256: sha256(data) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function directoriesFor(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    let parent = NodePath.posix.dirname(path);
    while (parent !== ".") {
      directories.add(parent);
      parent = NodePath.posix.dirname(parent);
    }
  }
  return [...directories].sort(
    (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
  );
}

function makeFixture(
  options: {
    readonly actualFiles?: Readonly<Record<string, Buffer>>;
    readonly embeddedInventory?: ReadonlyArray<InventoryRecord>;
    readonly detachedInventory?: ReadonlyArray<InventoryRecord>;
    readonly extraEntries?: ReadonlyArray<TarFixtureEntry>;
    readonly mutateTar?: (value: Buffer) => Buffer;
    readonly embeddedShaOverride?: string;
    readonly archiveShaOverride?: string;
    readonly archiveLengthOverride?: number;
    readonly budgets?: Partial<CtoxBusinessOsShellReleaseManifest["budgets"]>;
  } = {},
): Fixture {
  const actualFiles =
    options.actualFiles ??
    ({
      "assets/app.js": Buffer.from("export const ready = true;\n"),
      "index.html": Buffer.from("<!doctype html><title>CTOX</title>\n"),
    } satisfies Readonly<Record<string, Buffer>>);
  const embeddedInventory = options.embeddedInventory ?? inventory(actualFiles);
  const embedded = {
    schema: CTOX_BUSINESS_OS_SHELL_SCHEMA,
    version: VERSION,
    sourceCommit: SOURCE_COMMIT,
    entry: "index.html",
    archiveRoot: ARCHIVE_ROOT,
    files: embeddedInventory,
  };
  const embeddedBytes = Buffer.from(`${JSON.stringify(embedded, null, 2)}\n`);
  const entries: TarFixtureEntry[] = [
    { path: ARCHIVE_ROOT, typeByte: 0x35 },
    ...directoriesFor(Object.keys(actualFiles)).map((path) => ({
      path: `${ARCHIVE_ROOT}/${path}`,
      typeByte: 0x35,
    })),
    ...Object.entries(actualFiles).map(([path, data]) => ({
      path: `${ARCHIVE_ROOT}/${path}`,
      typeByte: 0x30,
      data,
    })),
    ...(options.extraEntries ?? []),
    {
      path: `${ARCHIVE_ROOT}/${CTOX_BUSINESS_OS_SHELL_EMBEDDED_MANIFEST}`,
      typeByte: 0x30,
      data: embeddedBytes,
    },
  ];
  const tarBytes = options.mutateTar?.(tar(entries)) ?? tar(entries);
  const archive = gzipSync(tarBytes, { level: 9 });
  const archiveSha = options.archiveShaOverride ?? sha256(archive);
  const archiveLength = options.archiveLengthOverride ?? archive.length;
  const embeddedSha = options.embeddedShaOverride ?? sha256(embeddedBytes);
  const detached = {
    ...embedded,
    files: options.detachedInventory ?? embeddedInventory,
    archiveFilename: ARCHIVE_FILENAME,
    archiveByteLength: archiveLength,
    archiveSha256: archiveSha,
    embeddedManifestSha256: embeddedSha,
  };
  const detachedManifest = Buffer.from(`${JSON.stringify(detached, null, 2)}\n`);
  const budgets = {
    maxManifestBytes: 64 * 1024,
    maxArchiveBytes: 1024 * 1024,
    maxTarEntries: 100,
    maxFiles: 20,
    maxFileBytes: 64 * 1024,
    maxTotalFileBytes: 256 * 1024,
    maxExpandedBytes: 1024 * 1024,
    maxPathBytes: 255,
    ...options.budgets,
  };
  const release: CtoxBusinessOsShellReleaseManifest = {
    schema: CTOX_BUSINESS_OS_SHELL_SCHEMA,
    version: VERSION,
    sourceCommit: SOURCE_COMMIT,
    manifestUrl: CTOX_BUSINESS_OS_SHELL_MANIFEST_URL,
    manifestByteLength: detachedManifest.length,
    manifestSha256: sha256(detachedManifest),
    archiveUrl: CTOX_BUSINESS_OS_SHELL_ARCHIVE_URL,
    archiveFilename: ARCHIVE_FILENAME,
    archiveRoot: ARCHIVE_ROOT,
    entry: "index.html",
    archiveByteLength: archiveLength,
    archiveSha256: archiveSha,
    embeddedManifestSha256: embeddedSha,
    fileCount: embeddedInventory.length,
    maxRedirects: 2,
    requestTimeoutMs: 10_000,
    budgets,
  };
  return { archive, detachedManifest, release };
}

function fixtureFetch(fixture: Fixture, counts?: { value: number }): CtoxBusinessOsShellFetch {
  return async (url) => {
    if (counts !== undefined) counts.value += 1;
    if (url === CTOX_BUSINESS_OS_SHELL_MANIFEST_URL)
      return new Response(Uint8Array.from(fixture.detachedManifest));
    if (url === CTOX_BUSINESS_OS_SHELL_ARCHIVE_URL)
      return new Response(Uint8Array.from(fixture.archive));
    return new Response(null, { status: 404 });
  };
}

async function withTempDirectory(run: (dependencyRoot: string) => Promise<void>): Promise<void> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOs.tmpdir(), "ctox-shell-test-"));
  try {
    await run(NodePath.join(root, ".deps"));
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

async function expectCode(
  run: () => Promise<unknown>,
  expectedCodes: ReadonlyArray<string>,
): Promise<void> {
  try {
    await run();
    assert.fail("Expected shell preparation to fail.");
  } catch (error) {
    assert.instanceOf(error, CtoxBusinessOsShellError);
    assert.include(expectedCodes, (error as CtoxBusinessOsShellError).code);
  }
}

async function assertNoPartialInstall(dependencyRoot: string): Promise<void> {
  const packageRoot = NodePath.join(dependencyRoot, "ctox-business-os-shell");
  const entries = await NodeFSP.readdir(packageRoot).catch(() => [] as string[]);
  assert.deepStrictEqual(entries, []);
}

it("installs a verified shell, reuses a revalidated cache, and rebuilds invalid cache bytes", async () => {
  await withTempDirectory(async (dependencyRoot) => {
    const fixture = makeFixture();
    const counts = { value: 0 };
    const first = await prepareCtoxBusinessOsShellForTest({
      dependencyRoot,
      releaseManifest: fixture.release,
      fetch: fixtureFetch(fixture, counts),
    });
    assert.equal(first.cache, "installed");
    assert.equal(
      await NodeFSP.readFile(NodePath.join(first.installPath, "index.html"), "utf8"),
      "<!doctype html><title>CTOX</title>\n",
    );
    assert.isTrue(
      (
        await NodeFSP.stat(
          NodePath.join(first.installPath, CTOX_BUSINESS_OS_SHELL_COMPLETION_SENTINEL),
        )
      ).isFile(),
    );
    await verifyCtoxBusinessOsShellInstall(first.installPath, fixture.release);

    const second = await prepareCtoxBusinessOsShellForTest({
      dependencyRoot,
      releaseManifest: fixture.release,
      fetch: fixtureFetch(fixture, counts),
    });
    assert.equal(second.cache, "hit");
    assert.equal(counts.value, 2);

    await NodeFSP.writeFile(NodePath.join(first.installPath, "index.html"), "tampered");
    const rebuilt = await prepareCtoxBusinessOsShellForTest({
      dependencyRoot,
      releaseManifest: fixture.release,
      fetch: fixtureFetch(fixture, counts),
    });
    assert.equal(rebuilt.cache, "installed");
    assert.equal(counts.value, 4);
    await verifyCtoxBusinessOsShellInstall(rebuilt.installPath, fixture.release);
  });
});

it("rejects oversized cache metadata and inventory files before reading their contents", async () => {
  await withTempDirectory(async (dependencyRoot) => {
    const fixture = makeFixture();
    const installed = await prepareCtoxBusinessOsShellForTest({
      dependencyRoot,
      releaseManifest: fixture.release,
      fetch: fixtureFetch(fixture),
    });
    const embeddedPath = NodePath.join(
      installed.installPath,
      CTOX_BUSINESS_OS_SHELL_EMBEDDED_MANIFEST,
    );
    await NodeFSP.truncate(embeddedPath, fixture.release.budgets.maxManifestBytes + 1);
    await expectCode(
      () => verifyCtoxBusinessOsShellInstall(installed.installPath, fixture.release),
      ["cache-invalid"],
    );

    const rebuilt = await prepareCtoxBusinessOsShellForTest({
      dependencyRoot,
      releaseManifest: fixture.release,
      fetch: fixtureFetch(fixture),
    });
    await NodeFSP.truncate(
      NodePath.join(rebuilt.installPath, "index.html"),
      fixture.release.budgets.maxFileBytes + 1,
    );
    await expectCode(
      () => verifyCtoxBusinessOsShellInstall(rebuilt.installPath, fixture.release),
      ["cache-invalid"],
    );
  });
});

it("resolves explicit, environment, and repository-local dependency roots", () => {
  assert.equal(
    resolveCtoxBusinessOsShellDependencyRoot({ repoRoot: "/repo", env: {} }),
    NodePath.join("/repo", ".deps"),
  );
  assert.equal(
    resolveCtoxBusinessOsShellDependencyRoot({
      repoRoot: "/repo",
      env: { T3CODE_CTOX_BUSINESS_OS_SHELL_DEPENDENCY_ROOT: "ci-deps" },
    }),
    NodePath.join("/repo", "ci-deps"),
  );
  assert.equal(
    resolveCtoxBusinessOsShellDependencyRoot({
      dependencyRoot: "/explicit/.deps",
      repoRoot: "/repo",
      env: { T3CODE_CTOX_BUSINESS_OS_SHELL_DEPENDENCY_ROOT: "ignored" },
    }),
    "/explicit/.deps",
  );
});

it("rejects archive SHA-256 and exact-length mismatches", async () => {
  await withTempDirectory(async (dependencyRoot) => {
    for (const fixture of [
      makeFixture({ archiveShaOverride: "0".repeat(64) }),
      (() => {
        const base = makeFixture();
        return makeFixture({ archiveLengthOverride: base.archive.length + 1 });
      })(),
    ]) {
      await expectCode(
        () =>
          prepareCtoxBusinessOsShellForTest({
            dependencyRoot,
            releaseManifest: fixture.release,
            fetch: fixtureFetch(fixture),
          }),
        ["download-mismatch"],
      );
      await assertNoPartialInstall(dependencyRoot);
    }
  });
});

it("rejects path traversal and absolute archive paths", async () => {
  await withTempDirectory(async (dependencyRoot) => {
    for (const badPath of [`${ARCHIVE_ROOT}/../escape.txt`, "/absolute.txt"] as const) {
      const fixture = makeFixture({
        extraEntries: [{ path: badPath, typeByte: 0x30, data: Buffer.from("bad") }],
      });
      await expectCode(
        () =>
          prepareCtoxBusinessOsShellForTest({
            dependencyRoot,
            releaseManifest: fixture.release,
            fetch: fixtureFetch(fixture),
          }),
        ["path-invalid"],
      );
      await assertNoPartialInstall(dependencyRoot);
    }
  });
});

it("rejects symlinks, hardlinks, devices, FIFOs, and other special USTAR entries", async () => {
  await withTempDirectory(async (dependencyRoot) => {
    for (const typeByte of [0x32, 0x31, 0x33, 0x34, 0x36, 0x37, 0x78, 0x67, 0x4c] as const) {
      const fixture = makeFixture({
        extraEntries: [
          {
            path: `${ARCHIVE_ROOT}/special-${typeByte}`,
            typeByte,
            ...(typeByte === 0x31 || typeByte === 0x32 ? { linkName: "index.html" } : {}),
          },
        ],
      });
      await expectCode(
        () =>
          prepareCtoxBusinessOsShellForTest({
            dependencyRoot,
            releaseManifest: fixture.release,
            fetch: fixtureFetch(fixture),
          }),
        ["tar-entry-type", "tar-invalid"],
      );
      await assertNoPartialInstall(dependencyRoot);
    }
  });
});

it("rejects invalid TAR header checksums and duplicate canonical paths", async () => {
  await withTempDirectory(async (dependencyRoot) => {
    const badChecksum = makeFixture({
      mutateTar(value) {
        const mutated = Buffer.from(value);
        mutated[0] = (mutated[0] ?? 0) ^ 1;
        return mutated;
      },
    });
    await expectCode(
      () =>
        prepareCtoxBusinessOsShellForTest({
          dependencyRoot,
          releaseManifest: badChecksum.release,
          fetch: fixtureFetch(badChecksum),
        }),
      ["tar-checksum"],
    );

    const duplicate = makeFixture({
      extraEntries: [
        {
          path: `${ARCHIVE_ROOT}/index.html`,
          typeByte: 0x30,
          data: Buffer.from("duplicate"),
        },
      ],
    });
    await expectCode(
      () =>
        prepareCtoxBusinessOsShellForTest({
          dependencyRoot,
          releaseManifest: duplicate.release,
          fetch: fixtureFetch(duplicate),
        }),
      ["duplicate-path"],
    );
    await assertNoPartialInstall(dependencyRoot);
  });
});

it("rejects entry, file, payload, and expanded-byte budget excess", async () => {
  await withTempDirectory(async (dependencyRoot) => {
    const fixtures = [
      makeFixture({ budgets: { maxTarEntries: 2 } }),
      makeFixture({ budgets: { maxFileBytes: 16 } }),
      makeFixture({ budgets: { maxTotalFileBytes: 48 } }),
      makeFixture({ budgets: { maxExpandedBytes: 1024 } }),
    ];
    for (const fixture of fixtures) {
      await expectCode(
        () =>
          prepareCtoxBusinessOsShellForTest({
            dependencyRoot,
            releaseManifest: fixture.release,
            fetch: fixtureFetch(fixture),
          }),
        ["budget-exceeded"],
      );
      await assertNoPartialInstall(dependencyRoot);
    }
  });
});

it("rejects an embedded manifest hash mismatch", async () => {
  await withTempDirectory(async (dependencyRoot) => {
    const fixture = makeFixture({ embeddedShaOverride: "f".repeat(64) });
    await expectCode(
      () =>
        prepareCtoxBusinessOsShellForTest({
          dependencyRoot,
          releaseManifest: fixture.release,
          fetch: fixtureFetch(fixture),
        }),
      ["embedded-manifest-mismatch"],
    );
    await assertNoPartialInstall(dependencyRoot);
  });
});

it("rejects inventory extra, missing, and file hash mismatches", async () => {
  await withTempDirectory(async (dependencyRoot) => {
    const normalFiles = {
      "assets/app.js": Buffer.from("export const ready = true;\n"),
      "index.html": Buffer.from("<!doctype html><title>CTOX</title>\n"),
    } satisfies Readonly<Record<string, Buffer>>;
    const expectedInventory = inventory(normalFiles);
    const fixtures = [
      makeFixture({
        actualFiles: { ...normalFiles, "extra.txt": Buffer.from("extra") },
        embeddedInventory: expectedInventory,
      }),
      makeFixture({
        actualFiles: { "index.html": normalFiles["index.html"] },
        embeddedInventory: expectedInventory,
      }),
      makeFixture({
        actualFiles: {
          ...normalFiles,
          "assets/app.js": Buffer.from("export const ready = false;"),
        },
        embeddedInventory: expectedInventory,
      }),
    ];
    for (const fixture of fixtures) {
      await expectCode(
        () =>
          prepareCtoxBusinessOsShellForTest({
            dependencyRoot,
            releaseManifest: fixture.release,
            fetch: fixtureFetch(fixture),
          }),
        ["inventory-mismatch", "cache-invalid"],
      );
      await assertNoPartialInstall(dependencyRoot);
    }
  });
});

it("cleans staging after interrupted streams and failing HTTP responses without logging bodies", async () => {
  await withTempDirectory(async (dependencyRoot) => {
    const fixture = makeFixture();
    const secretBody = "do-not-log-response-body-secret";
    const interruptedFetch: CtoxBusinessOsShellFetch = async (url) => {
      if (url === CTOX_BUSINESS_OS_SHELL_MANIFEST_URL)
        return new Response(Uint8Array.from(fixture.detachedManifest));
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(fixture.archive.subarray(0, 16));
            controller.error(new Error(secretBody));
          },
        }),
      );
    };
    try {
      await prepareCtoxBusinessOsShellForTest({
        dependencyRoot,
        releaseManifest: fixture.release,
        fetch: interruptedFetch,
      });
      assert.fail("Expected interrupted fetch to fail.");
    } catch (error) {
      assert.instanceOf(error, CtoxBusinessOsShellError);
      assert.notInclude((error as Error).message, secretBody);
    }
    await assertNoPartialInstall(dependencyRoot);

    const failingFetch: CtoxBusinessOsShellFetch = async () =>
      new Response(secretBody, { status: 503 });
    try {
      await prepareCtoxBusinessOsShellForTest({
        dependencyRoot,
        releaseManifest: fixture.release,
        fetch: failingFetch,
      });
      assert.fail("Expected failing fetch to fail.");
    } catch (error) {
      assert.instanceOf(error, CtoxBusinessOsShellError);
      assert.notInclude((error as Error).message, secretBody);
    }
    await assertNoPartialInstall(dependencyRoot);
  });
});

it("preserves a concurrently published valid install", async () => {
  await withTempDirectory(async (dependencyRoot) => {
    const fixture = makeFixture();
    let archiveRequests = 0;
    let releaseArchiveRequests: (() => void) | undefined;
    const bothArchiveRequests = new Promise<void>((resolve) => {
      releaseArchiveRequests = resolve;
    });
    const fetchImpl: CtoxBusinessOsShellFetch = async (url) => {
      if (url === CTOX_BUSINESS_OS_SHELL_MANIFEST_URL)
        return new Response(Uint8Array.from(fixture.detachedManifest));
      archiveRequests += 1;
      if (archiveRequests === 2) releaseArchiveRequests?.();
      await bothArchiveRequests;
      return new Response(Uint8Array.from(fixture.archive));
    };

    const [left, right] = await Promise.all([
      prepareCtoxBusinessOsShellForTest({
        dependencyRoot,
        releaseManifest: fixture.release,
        fetch: fetchImpl,
      }),
      prepareCtoxBusinessOsShellForTest({
        dependencyRoot,
        releaseManifest: fixture.release,
        fetch: fetchImpl,
      }),
    ]);
    assert.equal(left.installPath, right.installPath);
    assert.deepStrictEqual([left.cache, right.cache].sort(), ["hit", "installed"]);
    assert.equal(archiveRequests, 2);
    await verifyCtoxBusinessOsShellInstall(left.installPath, fixture.release);
    const packageEntries = await NodeFSP.readdir(NodePath.dirname(left.installPath));
    assert.deepStrictEqual(packageEntries, [VERSION]);
  });
});
