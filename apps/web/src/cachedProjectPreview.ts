import communityPreview from "./assets/project-previews/i-hate-ai.community.png";
import fzulPreview from "./assets/project-previews/fzul.app.png";
import flylabsPreview from "./assets/project-previews/flylabs.dev.png";
import kunstmenPreview from "./assets/project-previews/kunstmen.com.png";
import miltonPreview from "./assets/project-previews/miltonticket.app.png";
import ctoxPreview from "./assets/project-previews/ctox.dev.png";
import greppyPreview from "./assets/project-previews/greppy.xyz.png";
import pokedexPreview from "./assets/project-previews/mypokedex.app-logo.svg";

const cachedPreviews = new Map([
  ["https://i-hate-ai.community", communityPreview],
  ["https://fzul.app", fzulPreview],
  ["https://flylabs.dev", flylabsPreview],
  ["https://kunstmen.com", kunstmenPreview],
  ["https://www.kunstmen.com", kunstmenPreview],
  ["https://miltonticket.app", miltonPreview],
  ["https://ctox.dev", ctoxPreview],
  ["https://greppy.xyz", greppyPreview],
  ["https://mypokedex.app", pokedexPreview],
]);

/** Captured public homepages; edited URLs must not inherit an unrelated snapshot. */
export function resolveCachedProjectPreview(website: string | null | undefined) {
  if (!website) return null;
  try {
    const url = new URL(website);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    const image = cachedPreviews.get(url.origin);
    return image
      ? {
          image,
          capturedOn: "2026-10-07",
          kind: url.origin === "https://mypokedex.app" ? "logo" : "preview",
        }
      : null;
  } catch {
    return null;
  }
}

/** `owner/repo` of a GitHub repository URL (https, ssh or scp form); null for anything else. */
export function githubRepositorySlug(
  repositoryUrl: string | null | undefined,
): { readonly owner: string; readonly repo: string } | null {
  const value = repositoryUrl?.trim();
  if (!value) return null;
  const match =
    /^(?:https?:\/\/(?:www\.)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(
      value,
    );
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo || repo === "." || repo === "..") return null;
  return { owner, repo };
}

/** Repository identity of a local project's Git remote, as far as the card needs it. */
export type ProjectPreviewRepositoryIdentity = {
  readonly provider?: string | undefined;
  readonly owner?: string | undefined;
  readonly name?: string | undefined;
};

export type ProjectPreview = {
  readonly image: string;
  readonly kind: "preview" | "logo" | "github";
  /** Capture date of a stored website snapshot; GitHub previews are live. */
  readonly capturedOn: string | null;
};

/**
 * The card's preview: the captured website first, else the GitHub social preview of
 * the project's repository (configured repository URL, else the local Git remote).
 * No preview at all is `null`; the card then shows its content instead.
 */
export function resolveProjectPreview(input: {
  readonly websiteUrl: string | null | undefined;
  readonly repositoryUrl: string | null | undefined;
  readonly repositoryIdentity?: ProjectPreviewRepositoryIdentity | null | undefined;
}): ProjectPreview | null {
  const website = resolveCachedProjectPreview(input.websiteUrl);
  if (website) return { ...website, kind: website.kind === "logo" ? "logo" : "preview" };
  const identity = input.repositoryIdentity;
  const slug =
    githubRepositorySlug(input.repositoryUrl) ??
    (identity?.provider?.toLowerCase() === "github" && identity.owner && identity.name
      ? githubRepositorySlug(`https://github.com/${identity.owner}/${identity.name}`)
      : null);
  if (!slug) return null;
  return {
    image: `https://opengraph.githubassets.com/1/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.repo)}`,
    kind: "github",
    capturedOn: null,
  };
}
