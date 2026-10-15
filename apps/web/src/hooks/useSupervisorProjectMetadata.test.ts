import { describe, expect, it } from "vite-plus/test";
import type { ProjectOverview } from "@workjet/contracts";
import { supervisorProjectMetadataOverview } from "./useSupervisorProjectMetadata";

const meeting = { weekday: 3, time: "13:00", timezone: "Europe/Berlin" };

describe("supervisor project metadata overview", () => {
  it("starts from the domain fallback instead of inventing a cleared website when no overview exists", () => {
    const written = supervisorProjectMetadataOverview({
      title: "flylabs.dev",
      overview: undefined,
      regularMeeting: meeting,
      repositoryUrl: null,
    });
    expect(written).toEqual({
      websiteUrl: "https://flylabs.dev",
      slots: [null, null, null],
      regularMeeting: meeting,
      repositoryUrl: null,
    });
    expect(written).not.toHaveProperty("websiteUrlCleared");
    // Non-domain titles keep a null website without a clear marker.
    expect(
      supervisorProjectMetadataOverview({
        title: "Milton Ticket",
        overview: null,
        regularMeeting: null,
        repositoryUrl: null,
      }).websiteUrl,
    ).toBeNull();
  });
  it("preserves a saved website and an explicit editor clear", () => {
    const saved: ProjectOverview = {
      websiteUrl: "https://mypokedex.app",
      slots: [null, null, null],
    };
    expect(
      supervisorProjectMetadataOverview({
        title: "mypokedex.app",
        overview: saved,
        regularMeeting: null,
        repositoryUrl: "https://github.com/metric-space-ai/mypokedex",
      }).websiteUrl,
    ).toBe("https://mypokedex.app");
    const cleared: ProjectOverview = {
      websiteUrl: null,
      websiteUrlCleared: true,
      slots: [null, null, null],
    };
    expect(
      supervisorProjectMetadataOverview({
        title: "fzul.app",
        overview: cleared,
        regularMeeting: null,
        repositoryUrl: null,
      }),
    ).toEqual({ ...cleared, regularMeeting: null, repositoryUrl: null });
  });
});
