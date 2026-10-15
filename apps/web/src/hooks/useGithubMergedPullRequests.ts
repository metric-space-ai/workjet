import { useEffect, useState } from "react";
import type { ProjectOverviewPr } from "../projectOverviewModel";

/** owner/repo from a GitHub URL, or null for anything else. */
export function githubRepoSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const match =
    /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(
      url.trim(),
    );
  return match ? `${match[1]}/${match[2]}` : null;
}

type GithubPull = {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly merged_at: string | null;
  readonly body: string | null;
  readonly user: { readonly login: string } | null;
};

type GithubPullDetail = {
  readonly additions?: number;
  readonly deletions?: number;
  readonly changed_files?: number;
};

export function withDiffStats(pr: ProjectOverviewPr, detail: GithubPullDetail): ProjectOverviewPr {
  return {
    ...pr,
    additions: detail.additions ?? null,
    deletions: detail.deletions ?? null,
    changedFiles: detail.changed_files ?? null,
  };
}

export function mapGithubPulls(pulls: readonly GithubPull[]): ProjectOverviewPr[] {
  return pulls
    .filter((pull) => pull.merged_at !== null)
    .map((pull) => ({
      url: pull.html_url,
      number: pull.number,
      title: pull.title,
      state: "merged" as const,
      mergedAt: pull.merged_at,
      body: pull.body,
      author: pull.user?.login ?? null,
    }));
}

/**
 * Recently merged PRs of the project repository, read from the public GitHub
 * API (read-only, no token). A private repo or rate limit yields an empty list;
 * CTOX feed posts replace this once the supervisor writes them.
 */
export function useGithubMergedPullRequests(repositoryUrl: string | null | undefined) {
  const slug = githubRepoSlug(repositoryUrl);
  const [state, setState] = useState<{ slug: string | null; prs: ProjectOverviewPr[] }>({
    slug: null,
    prs: [],
  });
  useEffect(() => {
    if (!slug) return;
    const controller = new AbortController();
    void fetch(
      `https://api.github.com/repos/${slug}/pulls?state=closed&sort=updated&direction=desc&per_page=20`,
      {
        signal: controller.signal,
        headers: { Accept: "application/vnd.github+json" },
      },
    )
      .then((response) => (response.ok ? response.json() : []))
      .then(async (pulls: GithubPull[]) => {
        const prs = mapGithubPulls(pulls);
        setState({ slug, prs });
        // Diff size needs the single-PR endpoint; only the newest few (unauthenticated rate limit).
        const detailed = await Promise.all(
          prs.slice(0, 5).map((pr) =>
            fetch(`https://api.github.com/repos/${slug}/pulls/${pr.number}`, {
              signal: controller.signal,
              headers: { Accept: "application/vnd.github+json" },
            })
              .then((response) => (response.ok ? response.json() : null))
              .then((detail: GithubPullDetail | null) => (detail ? withDiffStats(pr, detail) : pr))
              .catch(() => pr),
          ),
        );
        setState({ slug, prs: [...detailed, ...prs.slice(5)] });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [slug]);
  return state.slug === slug ? state.prs : [];
}
