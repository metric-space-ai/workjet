// @effect-diagnostics nodeBuiltinImport:off -- release build transport outside the application runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { isCurrentGithubLinuxSshReceipt } from "./github-ssh-build-receipt.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const LANE = "/mnt/nvme1/build-lane";
const ARCHIVE = "workjet-server-linux-x64.tgz";

async function fileDigest(path: string) {
  return NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(path))
    .digest("hex");
}

/** Consume a prior admitted Linux build without holding a Mac lease for its build. */
export async function stagePrebuiltLinuxSshServer(input: {
  readonly repoRoot: string;
  readonly directory: string;
  readonly archiveDirectory: string;
  readonly owner: string | undefined;
}) {
  if (!input.owner?.trim())
    throw new Error("Mac packaging requires --gpu-build-owner <thread-id>.");
  const archive = NodePath.join(input.directory, ARCHIVE);
  const receiptName = `${ARCHIVE}.build-receipt.json`;
  const receipt = JSON.parse(
    await NodeFSP.readFile(NodePath.join(input.directory, receiptName), "utf8"),
  );
  const source = (
    await execFile("git", ["rev-parse", "HEAD"], { cwd: input.repoRoot })
  ).stdout.trim();
  const hash = await fileDigest(archive);
  if (
    receipt.exit !== 0 ||
    !((receipt.host === "gpu3" && process.env.GITHUB_ACTIONS !== "true") || isCurrentGithubLinuxSshReceipt(receipt, input.owner)) ||
    receipt.owner !== input.owner ||
    receipt.workjetSourceCommit !== source ||
    receipt.workjetLockSha256 !==
      (await fileDigest(NodePath.join(input.repoRoot, "pnpm-lock.yaml"))) ||
    receipt.workjetArchiveSha256 !== hash ||
    (await NodeFSP.readFile(`${archive}.sha256`, "utf8")).trim() !== `${hash}  ${ARCHIVE}`
  ) {
    throw new Error("Prebuilt Linux server source, owner, receipt or checksum mismatch.");
  }
  await NodeFSP.mkdir(input.archiveDirectory, { recursive: true });
  for (const name of [ARCHIVE, `${ARCHIVE}.sha256`, receiptName])
    await NodeFSP.copyFile(
      NodePath.join(input.directory, name),
      NodePath.join(input.archiveDirectory, name),
    );
  // The packager still verifies both JS entries against its fresh server build.
  return {
    receiptPath: NodePath.join(input.directory, receiptName),
    task: receipt.task,
    archiveSha256: hash,
  };
}

/** Same task per source checkout; the lane incrementally ships its exact Git state. */
export function linuxServerBuildTask(repoRoot: string) {
  return (
    "workjet-linux-ssh-" +
    NodeCrypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 12)
  );
}

/** Include linked web assets in the portable server input. */
export async function archiveServerDist(inputArchive: string, serverDist: string) {
  // The CLI build links client assets; their targets must travel to the other host.
  await execFile("tar", ["-chzf", inputArchive, "-C", serverDist, "."], {
    timeout: 120_000,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

/** Build native Linux dependencies on gpu3 around the fresh desktop server output. */
export async function buildLinuxSshServer(input: {
  readonly repoRoot: string;
  readonly serverDist: string;
  readonly archiveDirectory: string;
  readonly owner: string | undefined;
}) {
  if (!input.owner?.trim())
    throw new Error("Mac packaging requires --gpu-build-owner <thread-id>.");
  const source = (
    await execFile("git", ["rev-parse", "HEAD"], { cwd: input.repoRoot })
  ).stdout.trim();
  const lockSha256 = await fileDigest(NodePath.join(input.repoRoot, "pnpm-lock.yaml"));
  const stage = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-linux-ssh-"));
  const task = linuxServerBuildTask(input.repoRoot);
  const remote = `${LANE}/artifacts/${task}/${NodeCrypto.randomUUID()}`;
  const inputArchive = NodePath.join(stage, "server-dist.tgz");
  const output = NodePath.join(stage, "output");
  const host = await execFile("nc", ["-z", "-G", "1", "10.0.0.9", "22"]).then(
    () => "lan-gpu3",
    () => "ts-gpu3",
  );
  let completed = false;
  try {
    await NodeFSP.mkdir(output);
    await archiveServerDist(inputArchive, input.serverDist);
    await execFile("ssh", [...SSH_OPTIONS, host, `mkdir -p ${remote}`]);
    await execFile("scp", [...SSH_OPTIONS, inputArchive, `${host}:${remote}/server-dist.tgz`]);
    const { stdout } = await execFile(
      "greppy",
      [
        "bash-smart",
        "-e",
        "receipt /Volumes/tmp/",
        "--",
        NodePath.join(NodeOS.homedir(), ".codex/bin/gpu-build-run.sh"),
        "--owner",
        input.owner,
        "--task",
        task,
        "--host",
        "gpu3",
        "--jobs",
        "2",
        "--src",
        input.repoRoot,
        "--",
        "timeout",
        "--signal=TERM",
        "--kill-after=30s",
        "5400",
        "bash",
        "scripts/build-linux-ssh-server-lane.sh",
        remote,
      ],
      { cwd: input.repoRoot, timeout: 3 * 60 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
    );
    completed = true;

    const receiptPath = /receipt (\/Volumes\/tmp\/[^\r\n]+\.receipt\.json)/u.exec(stdout)?.[1];
    if (!receiptPath) throw new Error("Linux server lane did not return its receipt.");
    const receipt = JSON.parse(await NodeFSP.readFile(receiptPath, "utf8"));
    if (
      receipt.exit !== 0 ||
      receipt.host !== "gpu3" ||
      receipt.owner !== input.owner ||
      receipt.task !== task
    )
      throw new Error("Linux server build receipt does not match this packaging request.");
    for (const name of [ARCHIVE, `${ARCHIVE}.sha256`])
      await execFile("scp", [
        ...SSH_OPTIONS,
        `${host}:${remote}/output/${name}`,
        NodePath.join(output, name),
      ]);
    const digest = NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(NodePath.join(output, ARCHIVE)))
      .digest("hex");
    if (
      (await NodeFSP.readFile(NodePath.join(output, `${ARCHIVE}.sha256`), "utf8")).trim() !==
      `${digest}  ${ARCHIVE}`
    )
      throw new Error("Transferred Linux server archive checksum mismatch.");
    await NodeFSP.mkdir(input.archiveDirectory, { recursive: true });
    for (const name of [ARCHIVE, `${ARCHIVE}.sha256`])
      await NodeFSP.copyFile(
        NodePath.join(output, name),
        NodePath.join(input.archiveDirectory, name),
      );
    if (
      (await execFile("git", ["rev-parse", "HEAD"], { cwd: input.repoRoot })).stdout.trim() !==
        source ||
      (await fileDigest(NodePath.join(input.repoRoot, "pnpm-lock.yaml"))) !== lockSha256
    )
      throw new Error("Linux server source changed during its build.");
    await NodeFSP.writeFile(
      NodePath.join(input.archiveDirectory, `${ARCHIVE}.build-receipt.json`),
      JSON.stringify(
        {
          ...receipt,
          workjetSourceCommit: source,
          workjetLockSha256: lockSha256,
          workjetArchiveSha256: digest,
        },
        null,
        2,
      ) + "\n",
    );
    return { receiptPath, task, archiveSha256: digest };
  } finally {
    // A disconnected caller cannot assume the detached lane job has finished.
    if (completed) await execFile("ssh", [...SSH_OPTIONS, host, `rm -rf ${remote}`]);
    await NodeFSP.rm(stage, { recursive: true, force: true });
  }
}
