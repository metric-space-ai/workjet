// @effect-diagnostics nodeBuiltinImport:off -- release build transport outside the application runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const LANE = "/mnt/nvme1/build-lane";
const ARCHIVE = "workjet-server-linux-x64.tgz";

/** Same task per source checkout; the lane incrementally ships its exact Git state. */
export function linuxServerBuildTask(repoRoot: string) {
  return (
    "workjet-linux-ssh-" +
    NodeCrypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 12)
  );
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
    await execFile("tar", ["-czf", inputArchive, "-C", input.serverDist, "."], {
      timeout: 120_000,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
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
    await NodeFSP.copyFile(
      receiptPath,
      NodePath.join(input.archiveDirectory, `${ARCHIVE}.build-receipt.json`),
    );
    return { receiptPath, task, archiveSha256: digest };
  } finally {
    // A disconnected caller cannot assume the detached lane job has finished.
    if (completed) await execFile("ssh", [...SSH_OPTIONS, host, `rm -rf ${remote}`]);
    await NodeFSP.rm(stage, { recursive: true, force: true });
  }
}
