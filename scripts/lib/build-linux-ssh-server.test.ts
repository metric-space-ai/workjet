// @effect-diagnostics nodeBuiltinImport:off -- release transport contract.
import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { githubSshBuildIdentity } from "./github-ssh-build-receipt.ts";
import {
  buildLinuxSshServer,
  linuxServerBuildTask,
  stagePrebuiltLinuxSshServer,
} from "./build-linux-ssh-server.ts";

it("requires the packaging owner before starting SSH or a detached build", async () => {
  await NodeAssert.rejects(
    buildLinuxSshServer({
      repoRoot: "/unavailable/source",
      serverDist: "/unavailable/dist",
      archiveDirectory: "/unavailable/output",
      owner: undefined,
    }),
    /--gpu-build-owner/,
  );
});

it("keeps a lane task stable per checkout without exposing path bytes to the shell", () => {
  const source = "/Volumes/tmp/worktrees/workjet/packaging 'test'";
  NodeAssert.equal(linuxServerBuildTask(source), linuxServerBuildTask(source));
  NodeAssert.notEqual(linuxServerBuildTask(source), linuxServerBuildTask(source + "-other"));
  NodeAssert.match(linuxServerBuildTask(source), /^workjet-linux-ssh-[0-9a-f]{12}$/u);
});

async function withPrebuiltFixture(
  run: (data: {
    root: string;
    options: Parameters<typeof stagePrebuiltLinuxSshServer>[0];
    receipt: Record<string, unknown>;
    receiptPath: string;
    archive: string;
  }) => Promise<void>,
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-ci-prebuilt-"));
  try {
    NodeChildProcess.execFileSync("git", ["init", "-q", root]);
    NodeChildProcess.execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--allow-empty",
        "-qm",
        "fixture",
      ],
      { cwd: root },
    );
    const directory = NodePath.join(root, "download");
    await NodeFSP.mkdir(directory);
    const archive = NodePath.join(directory, "workjet-server-linux-x64.tgz");
    await NodeFSP.writeFile(archive, "verified fixture archive bytes");
    await NodeFSP.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "fixture lock");
    const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
    for (const [name, value] of Object.entries({
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY_ID: "12345",
      GITHUB_RUN_ID: "67890",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_SERVER_URL: "https://github.com",
    }))
      vi.stubEnv(name, value);
    const identity = githubSshBuildIdentity()!;
    const receipt = {
      exit: 0,
      host: "github-actions",
      owner: identity.owner,
      task: "ssh-server-linux-x64",
      github: identity.github,
      workjetSourceCommit: NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      workjetLockSha256: digest("fixture lock"),
      workjetArchiveSha256: digest("verified fixture archive bytes"),
    };
    const receiptPath = `${archive}.build-receipt.json`;
    await NodeFSP.writeFile(receiptPath, JSON.stringify(receipt));
    await NodeFSP.writeFile(
      `${archive}.sha256`,
      `${receipt.workjetArchiveSha256}  workjet-server-linux-x64.tgz\n`,
    );
    const options = {
      repoRoot: root,
      directory,
      archiveDirectory: NodePath.join(root, "staged"),
      owner: identity.owner,
    };
    await run({ root, options, receipt, receiptPath, archive });
  } finally {
    vi.unstubAllEnvs();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}
it("stages the same-run CI archive with its receipt and checksum without SSH", () =>
  withPrebuiltFixture(async ({ options, receipt }) => {
    const result = await stagePrebuiltLinuxSshServer(options);
    NodeAssert.equal(result.archiveSha256, receipt.workjetArchiveSha256);
    NodeAssert.equal(
      await NodeFSP.readFile(
        NodePath.join(options.archiveDirectory, "workjet-server-linux-x64.tgz"),
        "utf8",
      ),
      "verified fixture archive bytes",
    );
    NodeAssert.deepEqual(
      JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(
            options.archiveDirectory,
            "workjet-server-linux-x64.tgz.build-receipt.json",
          ),
          "utf8",
        ),
      ),
      receipt,
    );
  }));
for (const field of [
  "exit",
  "host",
  "owner",
  "workjetSourceCommit",
  "workjetLockSha256",
  "workjetArchiveSha256",
]) {
  it(`refuses mismatched prebuilt ${field}`, () =>
    withPrebuiltFixture(async ({ options, receipt, receiptPath }) => {
      await NodeFSP.writeFile(receiptPath, JSON.stringify({ ...receipt, [field]: "wrong" }));
      await NodeAssert.rejects(stagePrebuiltLinuxSshServer(options), /mismatch/);
      await NodeAssert.rejects(NodeFSP.access(options.archiveDirectory));
    }));
}
it("refuses CI provenance on an operator machine", () =>
  withPrebuiltFixture(async ({ options }) => {
    vi.stubEnv("GITHUB_ACTIONS", undefined);
    await NodeAssert.rejects(stagePrebuiltLinuxSshServer(options), /mismatch/);
  }));
it("keeps the existing owner-bound gpu3 receipt supported", () =>
  withPrebuiltFixture(async ({ options, receipt, receiptPath }) => {
    vi.stubEnv("GITHUB_ACTIONS", undefined);
    await NodeFSP.writeFile(
      receiptPath,
      JSON.stringify({ ...receipt, host: "gpu3", owner: "operator-thread" }),
    );
    await stagePrebuiltLinuxSshServer({ ...options, owner: "operator-thread" });
  }));
it("refuses corrupted archive bytes and checksum sidecars", () =>
  withPrebuiltFixture(async ({ options, archive }) => {
    await NodeFSP.appendFile(archive, "corruption");
    await NodeAssert.rejects(stagePrebuiltLinuxSshServer(options), /mismatch/);
    await NodeFSP.writeFile(archive, "verified fixture archive bytes");
    await NodeFSP.writeFile(`${archive}.sha256`, "incorrect checksum\n");
    await NodeAssert.rejects(stagePrebuiltLinuxSshServer(options), /mismatch/);
  }));
it("requires same-run CI provenance rather than a relabeled gpu3 receipt on Actions", () =>
  withPrebuiltFixture(async ({ options, receipt, receiptPath }) => {
    await NodeFSP.writeFile(receiptPath, JSON.stringify({ ...receipt, host: "gpu3" }));
    await NodeAssert.rejects(stagePrebuiltLinuxSshServer(options), /mismatch/);
  }));
it("stages an earlier same-run producer on a packaging-job retry", () =>
  withPrebuiltFixture(async ({ options, receipt, receiptPath }) => {
    const earlier = {
      ...receipt,
      owner: "github-actions:12345:67890:1",
      github: { ...(receipt.github as Record<string, unknown>), runAttempt: "1" },
    };
    await NodeFSP.writeFile(receiptPath, JSON.stringify(earlier));
    const result = await stagePrebuiltLinuxSshServer(options);
    NodeAssert.equal(result.archiveSha256, receipt.workjetArchiveSha256);
    await NodeFSP.writeFile(receiptPath, JSON.stringify({
      ...earlier, workjetSourceCommit: "wrong",
    }));
    await NodeAssert.rejects(stagePrebuiltLinuxSshServer(options), /mismatch/);
  }));
