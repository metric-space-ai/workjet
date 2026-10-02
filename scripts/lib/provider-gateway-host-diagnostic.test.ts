// @effect-diagnostics nodeBuiltinImport:off - Isolated source/receipt/corruption packaging fixtures.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { it } from "@effect/vitest";
import { decodeProviderGatewayHostDiagnostic } from "@workjet/shared/providerGatewayHostDiagnostic";
import {
  assertDiagnosticMachO,
  captureDiagnosticNativeSource,
  prepareDiagnosticProviderGatewayHost,
  stageDiagnosticProviderGatewayHost,
} from "./provider-gateway-host-diagnostic.ts";
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
function executable(arch: "arm64" | "x64" = "arm64") {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  bytes.writeUInt32LE(2, 12);
  return bytes;
}
async function fixture(run: (data: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const data = await createFixture();
  try {
    await run(data);
  } finally {
    await NodeFSP.rm(data.root, { recursive: true, force: true });
  }
}
async function createFixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-diagnostic-host-"));
  const git = (...args: string[]) =>
    execFile(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      { cwd: root },
    );
  await git("init", "-q");
  await NodeFSP.mkdir(NodePath.join(root, "native/provider-gateway-workjet-host"), {
    recursive: true,
  });
  await NodeFSP.mkdir(NodePath.join(root, "native/provider-gateway"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "native/provider-gateway-workjet-host/Cargo.toml"),
    '[package]\nname="fixture"\nversion="0.1.1"\n',
  );
  await NodeFSP.writeFile(NodePath.join(root, "native/provider-gateway/lib.rs"), "// fixture\n");
  await git("add", "native");
  await git("commit", "-qm", "fixture source");
  const binaryPath = NodePath.join(root, "compiled-host");
  await NodeFSP.writeFile(binaryPath, executable());
  const identity = await captureDiagnosticNativeSource(root);
  const manifestPath = await stageDiagnosticProviderGatewayHost({
    repoRoot: root,
    binaryPath,
    outDir: NodePath.join(root, "receipt"),
    arch: "arm64",
    expectedNativeSource: identity.nativeSource,
  });
  const options = {
    repoRoot: root,
    manifestPath,
    platform: "mac" as const,
    arch: "arm64" as const,
  };
  return { root, git, options, identity, binaryPath };
}
it("stages the real platform receipt and keeps published pins separate", () =>
  fixture(async ({ options }) => {
    const prepared = await prepareDiagnosticProviderGatewayHost(options);
    NodeAssert.match(prepared.version, /^diagnostic-/u);
    NodeAssert.equal(prepared.manifest.artifact.triple, "aarch64-apple-darwin");
    NodeAssert.deepEqual(
      await NodeFSP.readFile(NodePath.join(prepared.installPath, "workjet-provider-gateway-host")),
      executable(),
    );
    await NodeFSP.access(
      NodePath.join(prepared.installPath, "workjet-provider-gateway-host"),
      NodeFSP.constants.X_OK,
    );
  }));
it("reuses an unchanged native source across UI-only commits, rejects native drift and uncommitted native edits", () =>
  fixture(async ({ root, git, options }) => {
    await NodeFSP.writeFile(NodePath.join(root, "ui.txt"), "UI-only change");
    await git("add", "ui.txt");
    await git("commit", "-qm", "UI only");
    await prepareDiagnosticProviderGatewayHost(options);
    const native = NodePath.join(root, "native/provider-gateway/lib.rs");
    await NodeFSP.writeFile(native, "// changed native\n");
    await NodeAssert.rejects(prepareDiagnosticProviderGatewayHost(options), /Commit native/u);
    await git("add", "native");
    await git("commit", "-qm", "native changed");
    await NodeAssert.rejects(prepareDiagnosticProviderGatewayHost(options), /different native/u);
  }));
it("refuses source changes during compilation before creating a receipt", () =>
  fixture(async ({ root, git, identity, binaryPath }) => {
    await NodeFSP.writeFile(NodePath.join(root, "native/provider-gateway/lib.rs"), "// new\n");
    await git("add", "native");
    await git("commit", "-qm", "new");
    await NodeAssert.rejects(
      stageDiagnosticProviderGatewayHost({
        repoRoot: root,
        binaryPath,
        arch: "arm64",
        outDir: NodePath.join(root, "new-receipt"),
        expectedNativeSource: identity.nativeSource,
      }),
      /changed during/u,
    );
  }));
it("rejects wrong platform, universal package, architecture, symlinks and byte corruption", () =>
  fixture(async ({ root, options }) => {
    await NodeAssert.rejects(
      prepareDiagnosticProviderGatewayHost({ ...options, platform: "linux" }),
      /one explicitly built/u,
    );
    await NodeAssert.rejects(
      prepareDiagnosticProviderGatewayHost({ ...options, arch: "universal" }),
      /one explicitly built/u,
    );
    await NodeAssert.rejects(
      prepareDiagnosticProviderGatewayHost({ ...options, arch: "x64" }),
      /requested architecture/u,
    );
    const binary = NodePath.join(
      NodePath.dirname(options.manifestPath),
      "workjet-provider-gateway-host",
    );
    await NodeFSP.writeFile(binary, Buffer.alloc(64));
    await NodeAssert.rejects(prepareDiagnosticProviderGatewayHost(options), /size and SHA/u);
    await NodeFSP.rm(binary);
    await NodeFSP.symlink(NodePath.join(root, "compiled-host"), binary);
    await NodeAssert.rejects(prepareDiagnosticProviderGatewayHost(options), /bounded regular/u);
  }));
it("rejects receipt path traversal, excess fields, huge artifacts and mislabeled executable bytes", () =>
  fixture(async ({ options }) => {
    const manifest = JSON.parse(await NodeFSP.readFile(options.manifestPath, "utf8"));
    NodeAssert.throws(() =>
      decodeProviderGatewayHostDiagnostic({
        ...manifest,
        artifact: { ...manifest.artifact, fileName: "../other-host" },
      }),
    );
    NodeAssert.throws(() => decodeProviderGatewayHostDiagnostic({ ...manifest, extra: true }));
    NodeAssert.throws(() =>
      decodeProviderGatewayHostDiagnostic({
        ...manifest,
        artifact: { ...manifest.artifact, byteLength: 1024 * 1024 * 1024 },
      }),
    );
    NodeAssert.throws(() =>
      decodeProviderGatewayHostDiagnostic({
        ...manifest,
        artifact: { ...manifest.artifact, triple: "x86_64-apple-darwin" },
      }),
    );
    NodeAssert.throws(() => assertDiagnosticMachO(executable("x64"), "arm64"), /Mach-O/u);
    NodeAssert.throws(() => assertDiagnosticMachO(Buffer.alloc(64), "arm64"), /Mach-O/u);
  }));
