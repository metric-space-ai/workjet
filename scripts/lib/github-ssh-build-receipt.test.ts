// @effect-diagnostics nodeBuiltinImport:off -- isolated CI provenance fixtures.
import * as NodeAssert from "node:assert/strict";
import { afterEach, it, vi } from "vite-plus/test";
import {
  githubSshBuildIdentity,
  isCurrentGithubLinuxSshReceipt,
} from "./github-ssh-build-receipt.ts";

const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY_ID: "12345",
  GITHUB_RUN_ID: "67890",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_SERVER_URL: "https://github.com",
};
function current() {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return githubSshBuildIdentity(env)!;
}
afterEach(() => vi.unstubAllEnvs());

it("does not treat local CI=true or a declared owner as GitHub provenance", () => {
  NodeAssert.equal(githubSshBuildIdentity({ CI: "true" }), undefined);
  vi.stubEnv("GITHUB_ACTIONS", undefined);
  NodeAssert.equal(isCurrentGithubLinuxSshReceipt({ host: "github-actions" }, "owner"), false);
});
it("survives repository-name removal for the unconfigured desktop update feed", () => {
  const identity = current();
  vi.stubEnv("GITHUB_REPOSITORY", undefined);
  NodeAssert.equal(
    isCurrentGithubLinuxSshReceipt(
      {
        host: "github-actions",
        owner: identity.owner,
        task: "ssh-server-linux-x64",
        github: identity.github,
      },
      identity.owner,
    ),
    true,
  );
});
for (const name of Object.keys(env).filter((name) => name !== "GITHUB_ACTIONS")) {
  it(`rejects incomplete CI identity: ${name}`, () => {
    NodeAssert.throws(() => githubSshBuildIdentity({ ...env, [name]: "" }), /provenance/);
  });
}
for (const field of ["repositoryId", "runId", "runAttempt", "workflowSha", "serverUrl"]) {
  it(`rejects another producer ${field}`, () => {
    const identity = current();
    const receipt = {
      host: "github-actions",
      owner: identity.owner,
      task: "ssh-server-linux-x64",
      github: { ...identity.github, [field]: "different" },
    };
    NodeAssert.equal(isCurrentGithubLinuxSshReceipt(receipt, identity.owner), false);
  });
}
it("rejects a different owner, platform or omitted run identity", () => {
  const identity = current();
  const receipt = {
    host: "github-actions",
    owner: identity.owner,
    task: "ssh-server-linux-x64",
    github: identity.github,
  };
  NodeAssert.equal(isCurrentGithubLinuxSshReceipt(receipt, "other"), false);
  NodeAssert.equal(
    isCurrentGithubLinuxSshReceipt({ ...receipt, task: "ssh-server-linux-arm64" }, identity.owner),
    false,
  );
  NodeAssert.equal(
    isCurrentGithubLinuxSshReceipt({ ...receipt, github: null }, identity.owner),
    false,
  );
});
it("reuses a same-run producer from an earlier attempt on a failed-job retry", () => {
  const identity = current();
  const receipt = {
    host: "github-actions",
    owner: "github-actions:12345:67890:1",
    task: "ssh-server-linux-x64",
    github: { ...identity.github, runAttempt: "1" },
  };
  NodeAssert.equal(isCurrentGithubLinuxSshReceipt(receipt, identity.owner), true);
  NodeAssert.equal(isCurrentGithubLinuxSshReceipt({ ...receipt, owner: identity.owner }, identity.owner), false);
  NodeAssert.equal(isCurrentGithubLinuxSshReceipt({
    ...receipt, owner: "github-actions:12345:67890:3",
    github: { ...identity.github, runAttempt: "3" },
  }, identity.owner), false);
});
