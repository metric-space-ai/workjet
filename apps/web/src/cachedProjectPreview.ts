import communityPreview from "./assets/project-previews/i-hate-ai.community.png";
import fzulPreview from "./assets/project-previews/fzul.app.png";

const cachedPreviews = new Map([
  ["https://i-hate-ai.community", communityPreview],
  ["https://fzul.app", fzulPreview],
]);

/** Captured public homepages; edited URLs must not inherit an unrelated snapshot. */
export function resolveCachedProjectPreview(website: string | null | undefined) {
  if (!website) return null;
  try {
    const url = new URL(website);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const image = cachedPreviews.get(url.origin);
    return image ? { image, capturedOn: "2026-10-07" } : null;
  } catch {
    return null;
  }
}
