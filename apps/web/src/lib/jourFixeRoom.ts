/** View model only. Native receipts remain authoritative for meetings and goals. */
export interface JourFixeRoomSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly deckRevision: number;
  readonly state:
    | "planned"
    | "preparing"
    | "ready"
    | "live"
    | "review"
    | "confirmed"
    | "cancelled"
    | "failed";
  readonly scheduledAt: number;
  readonly timezone: string;
  /** Last goal revision supplied by the authority; unknown disables confirmation. */
  readonly previousGoalRevision?: number;
  readonly slides: readonly {
    readonly id: string;
    readonly position: number;
    readonly title: string;
    readonly markdown: string;
  }[];
  readonly comments: readonly {
    readonly id: string;
    readonly slideId: string;
    readonly deckRevision: number;
    readonly x: number;
    readonly y: number;
    readonly text: string;
  }[];
  readonly transcript: readonly {
    readonly id: string;
    readonly sequence: number;
    readonly speaker: "owner" | "supervisor";
    readonly streamId?: string;
    readonly text: string;
  }[];
  readonly todos?: {
    readonly revision: number;
    readonly status: "proposed" | "confirmed" | "superseded";
    readonly items: readonly JourFixeTodo[];
  };
  readonly error?: string;
}

export interface JourFixeTodo {
  readonly id: string;
  readonly title: string;
  readonly acceptance: string;
  readonly priority: "P0" | "P1" | "P2";
  readonly evidenceIds: readonly string[];
  readonly dueAt?: number;
  readonly owner?: string;
}

export interface JourFixeCommentDraft {
  readonly meetingId: string;
  readonly expectedRevision: number;
  readonly deckRevision: number;
  readonly slideId: string;
  readonly x: number;
  readonly y: number;
}

export function jourFixeCommentAnchor(
  meeting: JourFixeRoomSnapshot,
  slideId: string,
  point: { readonly x: number; readonly y: number },
  bounds: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
): JourFixeCommentDraft | null {
  if (
    !["ready", "live", "review"].includes(meeting.state) ||
    !meeting.slides.some((slide) => slide.id === slideId) ||
    ![point.x, point.y, bounds.left, bounds.top, bounds.width, bounds.height].every(
      Number.isFinite,
    ) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    point.x < bounds.left ||
    point.x > bounds.left + bounds.width ||
    point.y < bounds.top ||
    point.y > bounds.top + bounds.height
  )
    return null;
  return {
    meetingId: meeting.id,
    expectedRevision: meeting.revision,
    deckRevision: meeting.deckRevision,
    slideId,
    x: (point.x - bounds.left) / bounds.width,
    y: (point.y - bounds.top) / bounds.height,
  };
}

export function jourFixeCommentIsCurrent(
  meeting: JourFixeRoomSnapshot,
  draft: JourFixeCommentDraft,
): boolean {
  return (
    meeting.id === draft.meetingId &&
    meeting.revision === draft.expectedRevision &&
    meeting.deckRevision === draft.deckRevision &&
    ["ready", "live", "review"].includes(meeting.state) &&
    meeting.slides.some((slide) => slide.id === draft.slideId)
  );
}

export function jourFixeCommentsForSlide(meeting: JourFixeRoomSnapshot, slideId: string) {
  return meeting.comments.filter(
    (comment) => comment.slideId === slideId && comment.deckRevision === meeting.deckRevision,
  );
}

export function jourFixeEvidenceLabel(meeting: JourFixeRoomSnapshot, evidenceId: string): string {
  const slides = [...meeting.slides].sort((a, b) => a.position - b.position);
  const slideIndex = slides.findIndex((slide) => slide.id === evidenceId);
  if (slideIndex >= 0) return `Slide ${slideIndex + 1}`;
  const comment = meeting.comments.find((item) => item.id === evidenceId);
  if (comment) {
    const slideNumber = slides.findIndex((slide) => slide.id === comment.slideId) + 1;
    const siblings = meeting.comments.filter(
      (item) => item.slideId === comment.slideId && item.deckRevision === comment.deckRevision,
    );
    return `Comment ${siblings.findIndex((item) => item.id === comment.id) + 1}${comment.deckRevision !== meeting.deckRevision ? ` · Deck ${comment.deckRevision}` : slideNumber > 0 ? ` · Slide ${slideNumber}` : ""}`;
  }
  const turn = meeting.transcript.find((item) => item.id === evidenceId);
  if (turn) return `Transcript ${turn.sequence}`;
  return "Source unavailable";
}

export interface JourFixePartialTranscript {
  readonly streamId: string;
  readonly sequence: number;
  readonly text: string;
}

export function jourFixeVisiblePartial(
  meeting: JourFixeRoomSnapshot,
  partial: JourFixePartialTranscript | undefined,
): string | undefined {
  if (
    !partial ||
    meeting.transcript.some(
      (turn) => turn.streamId === partial.streamId && turn.sequence >= partial.sequence,
    )
  )
    return undefined;
  return partial.text;
}
