import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  WorkjetComputerId,
  DEFAULT_MEETING_PREPARATION_CONFIGURATION,
  type ProjectOverview,
} from "@workjet/contracts";
import {
  buildProjectGallery,
  decodeOverviewDraft,
  overviewDraft,
  projectUpdateAge,
  resolveGalleryProjectHistory,
  resolveGalleryProjectOverview,
  visibleGalleryProjects,
  websiteDraftChange,
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
  it("retains saved meeting preparation while unrelated overview data changes", () => {
    const saved: ProjectOverview = {
      websiteUrl: null,
      slots: [null, null, null],
      meetingPreparation: {
        ...DEFAULT_MEETING_PREPARATION_CONFIGURATION,
        enabled: false,
        leadMinutes: [720, 60],
      },
    };
    const draft = overviewDraft(saved);
    draft.websiteUrl = "https://ctox.dev";
    const updated = decodeOverviewDraft(draft);
    expect(updated.meetingPreparation).toEqual(saved.meetingPreparation);
    expect(updated.websiteUrl).toBe("https://ctox.dev");
    expect(
      decodeOverviewDraft(overviewDraft({ websiteUrl: null, slots: [null, null, null] })),
    ).not.toHaveProperty("meetingPreparation");
  });
  it("uses only domain-shaped titles for an unsaved overview and preserves saved clearing", () => {
    const card = {
      key: "a:native",
      id: "native",
      title: " Greppy.XYZ ",
      local: null,
      native: true,
    };
    expect(resolveGalleryProjectOverview(card)).toEqual({
      websiteUrl: "https://greppy.xyz",
      slots: [null, null, null],
    });
    for (const title of [
      "CTOX Crew",
      "127.0.0.1",
      "localhost",
      "bad-.example.org",
      "x.yz/path",
      "user@example.org",
    ]) {
      expect(resolveGalleryProjectOverview({ ...card, title }).websiteUrl).toBeNull();
    }
    const saved: ProjectOverview = {
      websiteUrl: null,
      websiteUrlCleared: true,
      slots: [null, null, null],
    };
    expect(
      resolveGalleryProjectOverview({
        ...card,
        local: { ...local("native", "a"), overview: saved },
      }),
    ).toBe(saved);
  });

  it("treats an unmarked null website from automatic syncs as never set and falls back to the domain", () => {
    const card = {
      key: "a:kunstmen",
      id: "kunstmen",
      title: "kunstmen.com",
      local: null,
      native: true,
    };
    const automatic: ProjectOverview = {
      tokenBudget: { limitBillions: null, revision: 0, jourFixe: null },
      websiteUrl: null,
      slots: [null, null, null],
    };
    expect(
      resolveGalleryProjectOverview({
        ...card,
        local: { ...local("kunstmen", "a"), overview: automatic },
      }),
    ).toEqual({ ...automatic, websiteUrl: "https://kunstmen.com" });
    // Non-domain titles keep a null website; the fallback only covers domains.
    expect(
      resolveGalleryProjectOverview({
        ...card,
        title: "Milton Ticket",
        local: { ...local("milton", "a"), overview: automatic },
      }).websiteUrl,
    ).toBeNull();
  });

  it("keeps a website cleared in the editor empty and drops the marker once a URL is entered", () => {
    const draft = overviewDraft({ websiteUrl: "https://example.org", slots: [null, null, null] });
    const cleared = decodeOverviewDraft(websiteDraftChange(draft, "  "));
    expect(cleared).toEqual({
      websiteUrl: null,
      websiteUrlCleared: true,
      slots: [null, null, null],
    });
    // The explicit marker survives later unrelated edits.
    const reopened = overviewDraft(cleared);
    expect(decodeOverviewDraft(reopened)).toEqual(cleared);
    // Entering a URL again removes the marker.
    expect(decodeOverviewDraft(websiteDraftChange(reopened, "https://example.org"))).toEqual({
      websiteUrl: "https://example.org",
      slots: [null, null, null],
    });
    // Clearing suppresses the domain fallback; an untouched empty field does not mark a clear.
    const card = {
      key: "a:example",
      id: "example",
      title: "example.org",
      local: { ...local("example", "a"), overview: cleared },
      native: false,
    };
    expect(resolveGalleryProjectOverview(card).websiteUrl).toBeNull();
    const untouchable = overviewDraft({ websiteUrl: null, slots: [null, null, null] });
    expect(decodeOverviewDraft(untouchable)).toEqual({
      websiteUrl: null,
      slots: [null, null, null],
    });
  });

  it("uses confirmed CTOX URLs and explicit clearing while preserving local KPI values", () => {
    const source = {
      ...local("native-config", "a"),
      overview: {
        websiteUrl: "https://old.example",
        slots: [{ kind: "text", label: "Status", value: "Live" }, null, null],
      } as ProjectOverview,
    };
    const configuration = {
      id: source.id,
      title: "ctox.dev",
      publicUrl: "https://ctox.dev",
      repoUrl: "https://github.com/metric-space-ai/ctox",
      workingCopies: [],
    };
    const [card] = buildProjectGallery({
      projects: [source],
      nativeProjects: [configuration],
      instanceId: "a",
      primaryEnvironmentId: source.environmentId,
    });
    expect(card?.configuration).toEqual(configuration);
    expect(resolveGalleryProjectOverview(card!)).toEqual({
      ...source.overview,
      websiteUrl: configuration.publicUrl,
      repositoryUrl: configuration.repoUrl,
    });
    expect(
      resolveGalleryProjectOverview({
        ...card!,
        configuration: { ...configuration, publicUrl: null },
      }).websiteUrl,
    ).toBeNull();
  });

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
  it("round trips and clears repository metadata without changing website or fields", () => {
    const overview: ProjectOverview = {
      repositoryUrl: "https://github.com/owner/repository",
      websiteUrl: null,
      slots: [{ kind: "text", label: "Status", value: "Review" }, null, null],
    };
    expect(decodeOverviewDraft(overviewDraft(overview))).toEqual(overview);
    const draft = overviewDraft(overview);
    draft.repositoryUrl = "";
    expect(decodeOverviewDraft(draft)).toEqual({ ...overview, repositoryUrl: null });
    const legacy = { websiteUrl: null, slots: [null, null, null] } as ProjectOverview;
    expect(decodeOverviewDraft(overviewDraft(legacy))).toEqual(legacy);
  });
  it("retains archived metadata through overview edits and restores the same joined history", () => {
    const saved: ProjectOverview = {
      archived: true,
      websiteUrl: "https://example.org",
      slots: [{ kind: "text", label: "Status", value: "Retained" }, null, null],
    };
    const archived = { ...local("retained", "a"), overview: saved };
    const active = local("active", "a");
    const cards = buildProjectGallery({
      projects: [archived, active],
      nativeProjects: [
        { id: archived.id, title: "Retained", workingCopies: [] },
        { id: active.id, title: "Active", workingCopies: [] },
      ],
      instanceId: "a",
      primaryEnvironmentId: archived.environmentId,
    });
    expect(visibleGalleryProjects(cards).map((card) => card.id)).toEqual(["active"]);
    expect(visibleGalleryProjects(cards, true).map((card) => card.id)).toEqual(["retained"]);
    expect(resolveGalleryProjectHistory([archived, active], cards, archived.id)).toBe(archived);
    const draft = overviewDraft(saved);
    draft.slots[0].value = "Edited";
    const edited = decodeOverviewDraft(draft);
    expect(edited.archived).toBe(true);
    expect(edited.slots[0]).toEqual({ kind: "text", label: "Status", value: "Edited" });
    const restored = cards.map((card) =>
      card.local?.id === archived.id
        ? { ...card, local: { ...archived, overview: { ...edited, archived: false } } }
        : card,
    );
    expect(visibleGalleryProjects(restored).map((card) => card.id)).toEqual(["retained", "active"]);
    expect(visibleGalleryProjects(restored, true)).toEqual([]);
    expect(cards).toHaveLength(2);
    expect(cards[0]?.local).toBe(archived);
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
  it("shows the canonical native title and retained preview through a proven physical alias", () => {
    const physical = {
      ...local("retained-history", null),
      workspaceRoot: "/work/source",
      overview: { websiteUrl: "https://example.org", slots: [null, null, null] } as ProjectOverview,
    };
    const canonical = {
      id: ProjectId.make("canonical"),
      title: "New canonical name",
      workingCopies: [
        {
          id: "copy",
          computerId: WorkjetComputerId.make("computer"),
          path: "/work/source",
          status: "active" as const,
        },
      ],
    };
    const older = { id: ProjectId.make("older"), title: physical.title, workingCopies: [] };
    const cards = buildProjectGallery({
      projects: [physical],
      nativeProjects: [canonical, older],
      instanceId: "a",
      primaryEnvironmentId: physical.environmentId,
      computers: [
        {
          id: WorkjetComputerId.make("computer"),
          environmentId: physical.environmentId,
          label: "Local",
          presentationKind: "local",
          harnesses: [],
        },
      ],
    });
    expect(cards.map((card) => card.id)).toEqual(["canonical", "older"]);
    expect(cards[0]?.title).toBe("New canonical name");
    expect(cards[0]?.local).toBe(physical);
    expect(cards[0]?.local?.overview?.websiteUrl).toBe("https://example.org");
    expect(cards[1]?.local).toBeNull();
    expect(physical.id).toBe("retained-history");
    const foreignEnvironment = {
      ...physical,
      environmentId: EnvironmentId.make("other"),
    };
    expect(resolveGalleryProjectHistory([foreignEnvironment, physical], cards, canonical.id)).toBe(
      physical,
    );
    expect(resolveGalleryProjectHistory([foreignEnvironment], cards, canonical.id)).toBeNull();
    expect(resolveGalleryProjectHistory([physical], cards, older.id)).toBeNull();
  });
  it("derives age from actual project time and never invents an unavailable timestamp", () => {
    const now = Date.parse("2026-10-02T02:00:00Z");
    expect(projectUpdateAge("2026-10-02T00:00:00Z", now)).toBe("2h ago");
    expect(projectUpdateAge(null, now)).toBe("Not available");
    expect(projectUpdateAge("invalid", now)).toBe("Not available");
  });
});
