import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationProjectShell } from "@workjet/contracts";
import { matchSessionProject, repositoryKey } from "./sessionProjectMatch.ts";

const project = (id: string, root: string | null, repo = id): OrchestrationProjectShell => ({
  id, workspaceRoot: root, repositoryIdentity: {
    canonicalKey: `github.com/example/${repo}`,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://github.com/example/${repo}.git` },
  },
} as OrchestrationProjectShell);

describe("history project matching", () => {
  it("maps all twelve projects by declared workspace or repository, irrespective of title", () => {
    const names = ["mypokedex.app", "I-hate-AI.community", "Learordie.app", "greppy.xyz", "dommify.dev", "flylabs.dev", "metric-space.ai", "fzul.app", "miltonticket.app", "ctox.dev", "kunstmen.com", "Molecularity"];
    const projects = names.map((name) => project(name, `/work/${name}`));
    for (const name of names) {
      expect(matchSessionProject({ workspaceRoot: `/work/${name}/src` }, projects)?.id).toBe(name);
      expect(matchSessionProject({ workspaceRoot: `/old/other-location`, repositoryUrl: `git@github.com:example/${name}.git` }, projects)?.id).toBe(name);
    }
  });
  it("normalizes SSH and HTTPS remotes without persisting credentials", () => {
    expect(repositoryKey("https://user:secret@github.com/Example/Repo.git?token=secret")).toBe("github.com/example/repo");
    expect(repositoryKey("git@github.com:Example/Repo.git")).toBe("github.com/example/repo");
  });
  it("uses the closest workspace and rejects equally matching projects", () => {
    const projects = [project("outer", "/work"), project("inner", "/work/nested")];
    expect(matchSessionProject({ workspaceRoot: "/work/nested/feature" }, projects)?.id).toBe("inner");
    expect(matchSessionProject({ workspaceRoot: "/work/nested" }, [...projects, project("duplicate", "/work/nested")])).toBeUndefined();
  });
  it("leaves unknown, ambiguous and sibling paths unassigned", () => {
    const projects = [project("one", "/work/repo", "shared"), project("two", "/other/repo", "shared")];
    expect(matchSessionProject({ workspaceRoot: "/work/repo-other" }, projects)).toBeUndefined();
    expect(matchSessionProject({ workspaceRoot: "/missing", repositoryUrl: "https://github.com/example/shared" }, projects)).toBeUndefined();
    expect(matchSessionProject({ workspaceRoot: null }, projects)).toBeUndefined();
  });
});
