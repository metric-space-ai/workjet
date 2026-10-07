// @effect-diagnostics nodeBuiltinImport:off -- release transport contract.
import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import { buildLinuxSshServer, linuxServerBuildTask } from "./build-linux-ssh-server.ts";

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
