import { describe, expect, it } from "vite-plus/test";
import {
  disruptionContent,
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
    expect(c.body).toContain("/login");
    expect(c.body).not.toContain("Please run");
    expect(c.actionLabel).toBe("Im Chat anmelden");
  });
  it("summarizes a step from the assistant preview without markdown", () => {
    const c = stepContent({
      name: "Measurements",
      preview: "## Done\n- **Validated** `cases.csv` against [lab](http://x)",
      goal: "Verify cases",
      goalDone: false,
      language: "en",
    });
    expect(c.body).toBe("Done Validated cases.csv against lab");
    expect(c.openItems).toEqual(["Goal: Verify cases"]);
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
