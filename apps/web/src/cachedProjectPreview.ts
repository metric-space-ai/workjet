import communityPreview from "./assets/project-previews/i-hate-ai.community.png";
import fzulPreview from "./assets/project-previews/fzul.app.png";
import flylabsPreview from "./assets/project-previews/flylabs.dev.png";
import kunstmenPreview from "./assets/project-previews/kunstmen.com.png";
import miltonPreview from "./assets/project-previews/miltonticket.app.png";
import ctoxPreview from "./assets/project-previews/ctox.dev.png";
import pokedexPreview from "./assets/project-previews/mypokedex.app-logo.svg";

const cachedPreviews = new Map([
  ["https://i-hate-ai.community", communityPreview],
  ["https://fzul.app", fzulPreview],
  ["https://flylabs.dev", flylabsPreview],
  ["https://kunstmen.com", kunstmenPreview],
  ["https://www.kunstmen.com", kunstmenPreview],
  ["https://miltonticket.app", miltonPreview],
  ["https://ctox.dev", ctoxPreview],
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
    return image ? { image, capturedOn: "2026-10-07", kind: url.origin === "https://mypokedex.app" ? "logo" : "preview" } : null;
  } catch {
    return null;
  }
}
