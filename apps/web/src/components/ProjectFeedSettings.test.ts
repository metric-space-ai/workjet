import { describe, expect, it } from "vitest";
import { readFeedPreferences } from "./ProjectFeedSettings";
import { feedSourceOf, githubPrImage } from "./ProjectOverviewView";

describe("feed preferences", () => {
  it("defaults to all sources on and Top", () => {
    const prefs = readFeedPreferences(null);
    expect(Object.values(prefs.sources).every(Boolean)).toBe(true);
    expect(prefs.defaultTab).toBe("top");
  });
  it("keeps stored choices and ignores broken storage", () => {
    expect(readFeedPreferences('{"sources":{"prs":false},"defaultTab":"latest"}')).toMatchObject({
      sources: { prs: false, results: true },
      defaultTab: "latest",
    });
    expect(readFeedPreferences("{nope").defaultTab).toBe("top");
  });
  it("maps post kinds to switchable sources", () => {
    expect(feedSourceOf("escalation")).toBe("disruptions");
    expect(feedSourceOf("goal")).toBe("results");
    expect(feedSourceOf("pr")).toBe("prs");
  });
  it("uses GitHub's card image only for PR URLs", () => {
    expect(githubPrImage("https://github.com/metric-space-ai/workjet/pull/734")).toBe(
      "https://opengraph.githubassets.com/1/metric-space-ai/workjet/pull/734",
    );
    expect(githubPrImage("https://example.com/x")).toBeNull();
  });
});
