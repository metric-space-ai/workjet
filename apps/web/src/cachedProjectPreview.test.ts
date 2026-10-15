import { describe, expect, it } from "vite-plus/test";
import {
  githubRepositorySlug,
  resolveCachedProjectPreview,
  resolveProjectPreview,
} from "./cachedProjectPreview";

describe("cached project preview identity", () => {
  it.each([
    "https://fzul.app",
    "https://i-hate-ai.community/",
    "https://flylabs.dev",
    "https://kunstmen.com",
    "https://miltonticket.app",
    "https://ctox.dev",
    "https://mypokedex.app",
  ])("uses a bundled screenshot for the captured homepage %s", (website) => {
    expect(resolveCachedProjectPreview(website)?.image).toBeTruthy();
  });

  it.each([
    null,
    "",
    "not a URL",
    "https://dommify.dev",
    "https://fzul.app/another-project",
    "https://fzul.app/?tenant=other",
    "https://fzul.app/#dashboard",
    "https://other:fzul@fzul.app/",
    "https://fzul.app:8443/",
    "http://fzul.app",
    "https://fzul.app.example.com",
  ])("does not borrow a snapshot for a different or cleared URL %s", (website) => {
    expect(resolveCachedProjectPreview(website)).toBeNull();
  });
});

describe("GitHub preview fallback (WP-K2)", () => {
  it.each([
    ["https://github.com/metric-space-ai/molecularity", "metric-space-ai/molecularity"],
    ["https://github.com/metric-space-ai/ctox.git", "metric-space-ai/ctox"],
    ["https://www.github.com/owner/repo/", "owner/repo"],
    ["git@github.com:owner/my.repo.git", "owner/my.repo"],
    ["ssh://git@github.com/owner/repo", "owner/repo"],
  ])("reads %s as %s", (url, slug) => {
    const parsed = githubRepositorySlug(url);
    expect(parsed && `${parsed.owner}/${parsed.repo}`).toBe(slug);
  });

  it.each([
    null,
    "",
    "https://gitlab.com/owner/repo",
    "https://github.com/owner",
    "https://github.com/owner/repo/tree/main",
    "https://github.com.evil.example/owner/repo",
    "https://user:token@github.com/owner/repo",
  ])("ignores %s", (url) => {
    expect(githubRepositorySlug(url)).toBeNull();
  });

  it("keeps a captured website snapshot ahead of GitHub", () => {
    expect(
      resolveProjectPreview({
        websiteUrl: "https://ctox.dev",
        repositoryUrl: "https://github.com/metric-space-ai/ctox",
      })?.kind,
    ).toBe("preview");
  });

  it("uses the repository social preview when no website snapshot exists", () => {
    expect(
      resolveProjectPreview({
        websiteUrl: "https://molecularity.example",
        repositoryUrl: "https://github.com/metric-space-ai/molecularity",
      }),
    ).toEqual({
      image: "https://opengraph.githubassets.com/1/metric-space-ai/molecularity",
      kind: "github",
      capturedOn: null,
    });
  });

  it("falls back to the local GitHub remote identity", () => {
    expect(
      resolveProjectPreview({
        websiteUrl: null,
        repositoryUrl: null,
        repositoryIdentity: { provider: "github", owner: "metric-space-ai", name: "workjet" },
      })?.image,
    ).toBe("https://opengraph.githubassets.com/1/metric-space-ai/workjet");
    expect(
      resolveProjectPreview({
        websiteUrl: null,
        repositoryUrl: null,
        repositoryIdentity: { provider: "gitlab", owner: "a", name: "b" },
      }),
    ).toBeNull();
  });
});
