import { describe, expect, it } from "vite-plus/test";
import { resolveCachedProjectPreview } from "./cachedProjectPreview";

describe("cached project preview identity", () => {
  it.each(["https://fzul.app", "https://i-hate-ai.community/", "https://flylabs.dev", "https://kunstmen.com", "https://miltonticket.app", "https://ctox.dev", "https://mypokedex.app"])(
    "uses a bundled screenshot for the captured homepage %s",
    (website) => {
      expect(resolveCachedProjectPreview(website)?.image).toBeTruthy();
    },
  );

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
