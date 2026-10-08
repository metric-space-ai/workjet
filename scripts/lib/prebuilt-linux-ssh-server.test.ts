// @effect-diagnostics nodeBuiltinImport:off -- isolated release handoff fixtures.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import { stagePrebuiltLinuxSshServer } from "./build-linux-ssh-server.ts";

const archiveName = "workjet-server-linux-x64.tgz";
const hash = (bytes: string | Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

async function fixture(run: (data: {
  root: string; receipt: Record<string, unknown>;
  input: Parameters<typeof stagePrebuiltLinuxSshServer>[0];
  writeReceipt: () => Promise<void>;
}) => Promise<void>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-linux-handoff-"));
  const directory = NodePath.join(root, "input");
  const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
  await NodeFSP.mkdir(directory);
  const bytes = "isolated archive fixture";
  await NodeFSP.writeFile(NodePath.join(directory, archiveName), bytes);
  await NodeFSP.writeFile(NodePath.join(directory, archiveName + ".sha256"), hash(bytes) + "  " + archiveName + "\n");
  const receipt: Record<string, unknown> = {
    exit: 0, host: "gpu3", owner: "test-owner", task: "workjet-linux-ssh-test",
    workjetSourceCommit: NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    workjetLockSha256: hash(await NodeFSP.readFile(NodePath.join(repoRoot, "pnpm-lock.yaml"))),
    workjetArchiveSha256: hash(bytes),
  };
  const writeReceipt = () => NodeFSP.writeFile(NodePath.join(directory, archiveName + ".build-receipt.json"), JSON.stringify(receipt));
  await writeReceipt();
  try {
    await run({ root, receipt, writeReceipt,
      input: { repoRoot, directory, archiveDirectory: NodePath.join(root, "output"), owner: "test-owner" } });
  } finally { await NodeFSP.rm(root, { recursive: true, force: true }); }
}

it("stages a source-matching admitted build without SSH or a new build", () =>
  fixture(async ({ input }) => {
    const result = await stagePrebuiltLinuxSshServer(input);
    NodeAssert.equal(result.archiveSha256, hash("isolated archive fixture"));
    NodeAssert.deepEqual((await NodeFSP.readdir(input.archiveDirectory)).sort(),
      [archiveName, archiveName + ".build-receipt.json", archiveName + ".sha256"].sort());
  }));

for (const [field, value] of [
  ["exit", 75], ["host", "gpu4"], ["owner", "foreign-owner"],
  ["workjetSourceCommit", "old-source"], ["workjetLockSha256", "old-lock"],
  ["workjetArchiveSha256", "old-archive"],
] as const) {
  it(`refuses a prebuilt archive with mismatching ${field} before staging`, () =>
    fixture(async ({ input, receipt, writeReceipt }) => {
      receipt[field] = value;
      await writeReceipt();
      await NodeAssert.rejects(stagePrebuiltLinuxSshServer(input), /mismatch/);
      await NodeAssert.rejects(NodeFSP.stat(input.archiveDirectory), { code: "ENOENT" });
    }));
}

it("refuses changed archive bytes and a mismatched checksum sidecar", () =>
  fixture(async ({ input }) => {
    await NodeFSP.appendFile(NodePath.join(input.directory, archiveName), "changed");
    await NodeAssert.rejects(stagePrebuiltLinuxSshServer(input), /mismatch/);
    await NodeFSP.writeFile(NodePath.join(input.directory, archiveName), "isolated archive fixture");
    await NodeFSP.writeFile(NodePath.join(input.directory, archiveName + ".sha256"), "invalid");
    await NodeAssert.rejects(stagePrebuiltLinuxSshServer(input), /mismatch/);
  }));
