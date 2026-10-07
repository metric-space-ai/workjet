import { describe, expect, it } from "vite-plus/test";
import { jourFixeCommentAnchor, jourFixeCommentIsCurrent, jourFixeCommentsForSlide, jourFixeEvidenceLabel, type JourFixeRoomSnapshot } from "./jourFixeRoom";

const meeting: JourFixeRoomSnapshot = {
  id: "meeting-1", projectId: "project-1", revision: 4, deckRevision: 2, state: "live",
  scheduledAt: 1791802800000, timezone: "Europe/Berlin",
  slides: [{ id: "slide-1", position: 0, title: "Progress", markdown: "Actual evidence" }],
  comments: [], transcript: [],
};
const bounds = { left: 100, top: 60, width: 800, height: 450 };
const anchor = () => jourFixeCommentAnchor(meeting, "slide-1", { x: 300, y: 285 }, bounds)!;

describe("Jour fixe comment identity and geometry", () => {
  it("binds a normalized pin to the observed meeting, deck and revision", () => {
    expect(anchor()).toEqual({ meetingId: "meeting-1", expectedRevision: 4, deckRevision: 2, slideId: "slide-1", x: .25, y: .5 });
  });
  it("rejects coordinates outside the stage rather than moving a comment", () => {
    expect(jourFixeCommentAnchor(meeting, "slide-1", { x: 99, y: 285 }, bounds)).toBeNull();
    expect(jourFixeCommentAnchor(meeting, "slide-1", { x: 300, y: 511 }, bounds)).toBeNull();
  });
  it("rejects non-finite or zero-sized layout observations", () => {
    expect(jourFixeCommentAnchor(meeting, "slide-1", { x: NaN, y: 285 }, bounds)).toBeNull();
    expect(jourFixeCommentAnchor(meeting, "slide-1", { x: 300, y: 285 }, { ...bounds, width: 0 })).toBeNull();
  });
  it("never targets a slide outside the observed deck", () => {
    expect(jourFixeCommentAnchor(meeting, "foreign-slide", { x: 300, y: 285 }, bounds)).toBeNull();
  });
  it("fences a pending draft when the meeting, revision or deck changes", () => {
    expect(jourFixeCommentIsCurrent(meeting, anchor())).toBe(true);
    for (const changed of [{ ...meeting, id: "meeting-2" }, { ...meeting, revision: 5 }, { ...meeting, deckRevision: 3 }]) {
      expect(jourFixeCommentIsCurrent(changed, anchor())).toBe(false);
    }
  });
  it("disallows new comments once the meeting is terminal", () => {
    for (const state of ["confirmed", "cancelled", "failed"] as const) {
      expect(jourFixeCommentAnchor({ ...meeting, state }, "slide-1", { x: 300, y: 285 }, bounds)).toBeNull();
      expect(jourFixeCommentIsCurrent({ ...meeting, state }, anchor())).toBe(false);
    }
  });
  it("does not put old-deck or other-slide comments on the current slide", () => {
    const comment = { id: "comment-1", slideId: "slide-1", deckRevision: 2, x: .25, y: .5, text: "Question" };
    expect(jourFixeCommentsForSlide({ ...meeting, comments: [comment, { ...comment, id: "old", deckRevision: 1 }, { ...comment, id: "foreign", slideId: "slide-2" }] }, "slide-1")).toEqual([comment]);
  });
});

describe("Jour fixe evidence labels", () => {
  it("resolves retained slide, comment and transcript identities without inventing a source", () => {
    const current = { ...meeting,
      comments: [{ id: "comment-1", slideId: "slide-1", deckRevision: 1, x: .2, y: .3, text: "Earlier deck" }],
      transcript: [{ id: "turn-1", sequence: 7, speaker: "owner" as const, text: "Acceptance" }],
    };
    expect(jourFixeEvidenceLabel(current, "slide-1")).toBe("Slide 1");
    expect(jourFixeEvidenceLabel(current, "comment-1")).toBe("Comment 1 · Slide 1");
    expect(jourFixeEvidenceLabel(current, "turn-1")).toBe("Transcript 7");
    expect(jourFixeEvidenceLabel(current, "unknown")).toBe("Source unavailable");
  });
});
