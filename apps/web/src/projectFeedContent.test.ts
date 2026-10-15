import { describe, expect, it } from "vite-plus/test";
import {
  disruptionContent,
  mergedPrContent,
  plainPreview,
  prSummaryFromBody,
  stepContent,
} from "./projectFeedContent";

describe("project feed content", () => {
  it("turns a raw CLI login error into what hangs, why and who acts", () => {
    const c = disruptionContent({
      name: "Projekt-Supervisor",
      lastError: "Not logged in · Please run /login",
      language: "de",
    });
    expect(c.headline).toBe("Projekt-Supervisor hängt");
    expect(c.body).toContain("nicht angemeldet");
    expect(c.body).not.toContain("Please run");
    expect(c.body.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(c.actionLabel).toBe("Im Chat anmelden");
    expect(c.details).toBe("Not logged in · Please run /login");
  });
  it("never shows an unknown English error as the visible line", () => {
    const c = disruptionContent({ name: "Pinball", lastError: "Build failed", language: "de" });
    expect(c.body).toBe("Der letzte Lauf ist abgebrochen.");
    expect(c.body).not.toContain("Build failed");
    expect(c.details).toBe("Build failed");
    expect(c.actionLabel).toBeNull();
  });
  it("has no filler for a step without summary or a PR without description", () => {
    expect(
      stepContent({ name: "X", preview: null, goal: null, goalDone: false, language: "de" }),
    ).toBeNull();
    expect(
      mergedPrContent({ number: 1, title: "T", url: "https://x", body: null, language: "de" }).body,
    ).toBe("");
  });
  it("summarizes a step from the assistant preview without markdown", () => {
    const c = stepContent({
      name: "Measurements",
      preview: "## Done\n- **Validated** `cases.csv` against [lab](http://x)",
      goal: "Verify cases",
      goalDone: false,
      language: "en",
    });
    expect(c?.body).toBe("Done Validated cases.csv against lab");
    expect(c?.openItems).toEqual(["Goal: Verify cases"]);
  });
  it("bounds long previews", () => {
    expect(plainPreview("a ".repeat(400), 50)?.length).toBe(50);
  });
  it("summarizes a PR body in at most two sentences", () => {
    expect(
      prSummaryFromBody(
        "Closes #12.\n\n## Summary\nAdds the feed. It replaces banners. Third sentence.\n- [ ] checked",
      ),
    ).toBe("Adds the feed. It replaces banners.");
    expect(prSummaryFromBody("")).toBeNull();
  });
});

describe("prSummaryFromBody issue refs", () => {
  it("drops a leading 'Closes 698.' sentence", () => {
    expect(prSummaryFromBody("Closes 698. Overview names the reason. More. Even more.")).toBe(
      "Overview names the reason. More.",
    );
  });
});
