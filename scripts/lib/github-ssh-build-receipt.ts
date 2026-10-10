// @effect-diagnostics nodeBuiltinImport:off -- CI artifact provenance outside the application runtime.
/** GitHub-hosted builders cannot use the operator's private gpu3 admission lane. */
export function githubSshBuildIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (env.GITHUB_ACTIONS !== "true") return undefined;
  const github = {
    repositoryId: env.GITHUB_REPOSITORY_ID,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    workflowSha: env.GITHUB_SHA,
    serverUrl: env.GITHUB_SERVER_URL,
  };
  for (const name of ["repositoryId", "runId", "runAttempt"] as const) {
    if (!/^[1-9][0-9]*$/u.test(github[name] ?? ""))
      throw new Error(`Missing GitHub SSH artifact provenance: ${name}.`);
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(github.workflowSha ?? "") || !github.serverUrl)
    throw new Error("Missing GitHub SSH artifact provenance: source or server.");
  const server = new URL(github.serverUrl);
  if (server.protocol !== "https:" || server.username || server.password || server.origin !== github.serverUrl)
    throw new Error("Invalid GitHub SSH artifact server.");
  return {
    owner: `github-actions:${github.repositoryId}:${github.runId}:${github.runAttempt}`,
    github,
  };
}

/** Accept only artifacts downloaded from this same repository/run/attempt. */
export function isCurrentGithubLinuxSshReceipt(
  receipt: Record<string, unknown>,
  owner: string,
) {
  const current = githubSshBuildIdentity();
  if (!current || receipt.host !== "github-actions" || owner !== current.owner || receipt.owner !== owner || receipt.task !== "ssh-server-linux-x64")
    return false;
  const github = receipt.github;
  if (typeof github !== "object" || github === null || Array.isArray(github)) return false;
  const fields = github as Record<string, unknown>;
  return Object.entries(current.github).every(([name, value]) => fields[name] === value);
}
