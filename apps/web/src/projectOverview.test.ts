import { describe, expect, it } from "vite-plus/test";
import { CommandId, EnvironmentId, ProjectId, type ProjectOverview } from "@workjet/contracts";
import {
  buildProjectGallery,
  decodeOverviewDraft,
  overviewDraft,
  projectUpdateAge,
  type GalleryLocalProject,
} from "./projectOverview";
const local = (
  id: string,
  instance: string | null,
  environment: string = "local",
): GalleryLocalProject => ({
  id: ProjectId.make(id),
  title: id,
  environmentId: EnvironmentId.make(environment),
  updatedAt: "2026-10-02T00:00:00.000Z",
  ctoxRegistration:
    instance === null
      ? null
      : {
          instanceId: instance,
          commandId: CommandId.make("registration"),
          status: "pending",
        },
});
describe("real project overview", () => {
  it("round trips independently configured fields and clearing", () => {
    const overview: ProjectOverview = {
      websiteUrl: "https://example.org",
      slots: [
        { kind: "text", label: "Status", value: "Review" },
        { kind: "link", label: "Plan", url: "https://example.org/plan" },
        { kind: "metric", label: "Entered total", value: 0, unit: "items" },
      ],
    };
    expect(decodeOverviewDraft(overviewDraft(overview))).toEqual(overview);
    const draft = overviewDraft(overview);
    draft.websiteUrl = "";
    draft.slots[1].kind = "empty";
    expect(decodeOverviewDraft(draft)).toEqual({
      ...overview,
      websiteUrl: null,
      slots: [overview.slots[0], null, overview.slots[2]],
    });
    const empty = overviewDraft(null);
    expect(decodeOverviewDraft(empty)).toEqual({ websiteUrl: null, slots: [null, null, null] });
  });
  it("never turns an empty entered metric into zero", () => {
    const draft = overviewDraft(null);
    draft.slots[0] = { kind: "metric", label: "Total", value: "", unit: "" };
    expect(() => decodeOverviewDraft(draft)).toThrow();
  });
  it("joins tenant and native IDs, preserves local pending projects and excludes foreign records", () => {
    const own = local("same", "a"),
      foreign = local("same", "b", "foreign"),
      pending = local("pending", "a");
    const cards = buildProjectGallery({
      projects: [foreign, own, pending, local("unregistered", null)],
      nativeProjects: [{ id: own.id, title: "Native", workingCopies: [] }],
      instanceId: "a",
      primaryEnvironmentId: own.environmentId,
    });
    expect(cards.map((card) => card.id)).toEqual(["same", "pending"]);
    expect(cards[0]?.local).toBe(own);
    expect(cards[1]?.native).toBe(false);
  });
  it("deduplicates logical IDs only inside an instance, preserving standalone environment identity", () => {
    const a = local("same", "a"),
      b = local("same", "a", "other");
    expect(
      buildProjectGallery({
        projects: [a, b],
        nativeProjects: [],
        instanceId: "a",
        primaryEnvironmentId: a.environmentId,
      }),
    ).toHaveLength(1);
    const standalone = [local("same", null), local("same", null, "other")];
    expect(
      buildProjectGallery({
        projects: standalone,
        nativeProjects: [],
        instanceId: null,
        primaryEnvironmentId: null,
      }).map((card) => card.key),
    ).toEqual(["local:same", "other:same"]);
  });
  it("derives age from actual project time and never invents an unavailable timestamp", () => {
    const now = Date.parse("2026-10-02T02:00:00Z");
    expect(projectUpdateAge("2026-10-02T00:00:00Z", now)).toBe("2h ago");
    expect(projectUpdateAge(null, now)).toBe("Not available");
    expect(projectUpdateAge("invalid", now)).toBe("Not available");
  });
});
