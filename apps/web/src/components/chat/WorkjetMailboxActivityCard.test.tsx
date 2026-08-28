import type { ReactElement, ReactNode } from "react";
import { Children, isValidElement } from "react";
import {
  EnvironmentId,
  ThreadId,
  type WorkjetDelegationState,
  type WorkjetDeliveryDisposition,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  availableDelegationActions,
  delegationStateToneClass,
  dispositionBadgeLabel,
  EMPTY_DELEGATION_ACTION_STATE,
  parseDelegationReasons,
  parseWorkjetMailboxActivity,
  shortEnvironmentId,
  WORKJET_MAILBOX_ACTIVITY_KIND_SET,
  WorkjetMailboxActivityCard,
  type WorkjetDelegationAction,
  type WorkjetDelegationActionState,
  type WorkjetMailboxCardModel,
} from "./WorkjetMailboxActivityCard";

type InspectableElement = ReactElement<
  Readonly<Record<string, unknown>> & { readonly children?: ReactNode }
>;

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(" ");
  if (isValidElement(node)) {
    return textContent((node as InspectableElement).props.children);
  }
  return "";
}

function descendants(node: ReactNode): InspectableElement[] {
  const found: InspectableElement[] = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const element = child as InspectableElement;
    found.push(element, ...descendants(element.props.children));
  }
  return found;
}

const LOCAL_ENVIRONMENT = "environment-local-machine";
const REMOTE_ENVIRONMENT = "environment-remote-machine";

const address = (environmentId: string, threadId: string) => ({
  workspaceId: "ctox-business-os:mesh-alpha",
  environmentId,
  threadId,
});

const payload = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  envelopeId: "wjm-0123456789abcdef",
  direction: "outbound",
  source: address(LOCAL_ENVIRONMENT, "thread-orchestrator"),
  target: address(LOCAL_ENVIRONMENT, "thread-worker"),
  createdAt: "2026-08-18T10:00:00.000Z",
  expiresAt: "2026-08-18T11:00:00.000Z",
  ...overrides,
});

const model = (overrides: Partial<WorkjetMailboxCardModel> = {}): WorkjetMailboxCardModel => ({
  kind: "message",
  direction: "outbound",
  peerEnvironmentId: EnvironmentId.make(LOCAL_ENVIRONMENT),
  peerThreadId: ThreadId.make("thread-worker"),
  peerIsLocal: true,
  disposition: "accepted-new",
  delegationState: null,
  delegationId: null,
  peerWorkspaceId: "ctox-business-os:mesh-alpha" as WorkjetMailboxCardModel["peerWorkspaceId"],
  ...overrides,
});

const taskModel = (overrides: Partial<WorkjetMailboxCardModel> = {}): WorkjetMailboxCardModel =>
  model({
    kind: "task",
    delegationId: "wjd-0123456789abcdef" as WorkjetMailboxCardModel["delegationId"],
    delegationState: "running",
    ...overrides,
  });

const findButton = (children: ReactNode, action: string) =>
  descendants(children).find(
    (element) => element.props["data-workjet-delegation-action"] === action,
  );

const actionCard = (
  overrides: Partial<WorkjetMailboxCardModel>,
  extra: {
    readonly viewerIsReviewer?: boolean;
    readonly actionState?: WorkjetDelegationActionState;
    readonly onDelegationAction?: (action: WorkjetDelegationAction) => void;
    readonly onActionStateChange?: (next: WorkjetDelegationActionState) => void;
    readonly reassignThreads?: ReadonlyArray<{
      readonly threadId: string;
      readonly title: string;
    }>;
  } = {},
) =>
  WorkjetMailboxActivityCard({
    model: taskModel(overrides),
    onDelegationAction: extra.onDelegationAction ?? vi.fn(),
    onActionStateChange: extra.onActionStateChange ?? vi.fn(),
    ...(extra.viewerIsReviewer !== undefined ? { viewerIsReviewer: extra.viewerIsReviewer } : {}),
    ...(extra.actionState !== undefined ? { actionState: extra.actionState } : {}),
    ...(extra.reassignThreads !== undefined ? { reassignThreads: extra.reassignThreads } : {}),
  }) as InspectableElement;

const REASSIGN_THREADS = [
  { threadId: "thread-second-worker", title: "Second worker" },
  { threadId: "thread-third-worker", title: "Third worker" },
] as const;

describe("parseWorkjetMailboxActivity", () => {
  it("covers exactly the four mailbox activity kinds", () => {
    expect([...WORKJET_MAILBOX_ACTIVITY_KIND_SET].toSorted()).toEqual([
      "workjet.delegation.received",
      "workjet.delegation.sent",
      "workjet.message.received",
      "workjet.message.sent",
    ]);
  });

  it("ignores every unrelated activity kind", () => {
    expect(parseWorkjetMailboxActivity("checkpoint.captured", payload())).toBeNull();
    expect(parseWorkjetMailboxActivity("tool.completed", payload())).toBeNull();
  });

  it("reads the TARGET as the peer of an outbound message", () => {
    const parsed = parseWorkjetMailboxActivity("workjet.message.sent", payload());

    expect(parsed).toEqual({
      kind: "message",
      direction: "outbound",
      peerEnvironmentId: LOCAL_ENVIRONMENT,
      peerThreadId: "thread-worker",
      peerIsLocal: true,
      disposition: null,
      delegationState: null,
      delegationId: null,
      peerWorkspaceId: "ctox-business-os:mesh-alpha",
    });
  });

  it("reads the SOURCE as the peer of an inbound delegation and keeps its state", () => {
    const parsed = parseWorkjetMailboxActivity(
      "workjet.delegation.received",
      payload({
        direction: "inbound",
        disposition: "accepted-new",
        delegationId: "wjd-0123456789abcdef",
        delegationState: "delivered",
      }),
    );

    expect(parsed).toEqual({
      kind: "task",
      direction: "inbound",
      peerEnvironmentId: LOCAL_ENVIRONMENT,
      peerThreadId: "thread-orchestrator",
      peerIsLocal: true,
      disposition: "accepted-new",
      delegationState: "delivered",
      delegationId: "wjd-0123456789abcdef",
      peerWorkspaceId: "ctox-business-os:mesh-alpha",
    });
  });

  it("marks a cross-environment peer as not local", () => {
    const parsed = parseWorkjetMailboxActivity(
      "workjet.message.sent",
      payload({ target: address(REMOTE_ENVIRONMENT, "thread-remote") }),
    );

    expect(parsed?.peerIsLocal).toBe(false);
    expect(parsed?.peerEnvironmentId).toBe(REMOTE_ENVIRONMENT);
  });

  it("degrades to no card for a payload this build cannot read", () => {
    expect(parseWorkjetMailboxActivity("workjet.message.sent", null)).toBeNull();
    expect(parseWorkjetMailboxActivity("workjet.message.sent", { schemaVersion: 1 })).toBeNull();
    expect(
      parseWorkjetMailboxActivity("workjet.message.sent", payload({ direction: "sideways" })),
    ).toBeNull();
  });
});

describe("mailbox badge vocabulary", () => {
  it("names every delivery disposition and treats an absent one as queued", () => {
    const dispositions: ReadonlyArray<WorkjetDeliveryDisposition | null> = [
      "accepted-new",
      "duplicate-ignored",
      "expired",
      "rejected",
      null,
    ];
    expect(dispositions.map(dispositionBadgeLabel)).toEqual([
      "delivered",
      "duplicate ignored",
      "expired",
      "rejected",
      "queued",
    ]);
  });

  it("tones every delegation state literal in the contract", () => {
    const states: ReadonlyArray<WorkjetDelegationState> = [
      "queued",
      "delivered",
      "accepted",
      "running",
      "needs-input",
      "review-requested",
      "changes-requested",
      "completed",
      "failed",
      "cancelled",
      "expired",
    ];
    const tones = new Map(states.map((state) => [state, delegationStateToneClass(state)]));

    expect(tones.get("running")).toBe("text-info");
    expect(tones.get("accepted")).toBe("text-info");
    expect(tones.get("completed")).toBe("text-success");
    expect(tones.get("failed")).toBe("text-destructive");
    expect(tones.get("cancelled")).toBe("text-destructive");
    expect(tones.get("expired")).toBe("text-muted-foreground");
    expect(tones.get("needs-input")).toBe("text-warning");
    expect(tones.get("review-requested")).toBe("text-warning");
    expect(tones.get("changes-requested")).toBe("text-warning");
    expect(tones.get("queued")).toBe("text-muted-foreground");
    expect(tones.get("delivered")).toBe("text-muted-foreground");
    // Every literal is answered; none falls through to undefined.
    for (const state of states) {
      expect(typeof tones.get(state)).toBe("string");
    }
  });

  it("shortens only a long environment id", () => {
    expect(shortEnvironmentId("env-short")).toBe("env-short");
    expect(shortEnvironmentId("environment-local-machine")).toBe("environment-…");
  });
});

describe("WorkjetMailboxActivityCard", () => {
  it("labels direction and kind for all four combinations", () => {
    const cases = [
      { kind: "message" as const, direction: "outbound" as const, expected: "Message to" },
      { kind: "message" as const, direction: "inbound" as const, expected: "Message from" },
      { kind: "task" as const, direction: "outbound" as const, expected: "Task to" },
      { kind: "task" as const, direction: "inbound" as const, expected: "Task from" },
    ];

    for (const testCase of cases) {
      const card = WorkjetMailboxActivityCard({
        model: model({ kind: testCase.kind, direction: testCase.direction }),
      }) as InspectableElement;
      expect(textContent(card.props.children)).toContain(testCase.expected);
      expect(card.props["data-workjet-mailbox-card"]).toBe(testCase.kind);
    }
  });

  it("renders every disposition variant as its own badge text", () => {
    for (const [disposition, label] of [
      ["accepted-new", "delivered"],
      ["duplicate-ignored", "duplicate ignored"],
      ["expired", "expired"],
      ["rejected", "rejected"],
      [null, "queued"],
    ] as ReadonlyArray<[WorkjetDeliveryDisposition | null, string]>) {
      const card = WorkjetMailboxActivityCard({
        model: model({ disposition }),
      }) as InspectableElement;
      expect(textContent(card.props.children)).toContain(label);
    }
  });

  it("renders the delegation state badge with its restrained tone", () => {
    const card = WorkjetMailboxActivityCard({
      model: model({ kind: "task", delegationState: "review-requested" }),
    }) as InspectableElement;
    const badge = descendants(card.props.children).find(
      (element) => textContent(element.props.children) === "review-requested",
    );

    expect(badge).toBeDefined();
    expect(badge?.props.className).toBe("text-warning");
  });

  it("omits the state badge for a plain message", () => {
    const card = WorkjetMailboxActivityCard({ model: model() }) as InspectableElement;
    const states = descendants(card.props.children).filter((element) =>
      ["queued", "running", "completed"].includes(textContent(element.props.children)),
    );

    expect(states).toEqual([]);
  });

  it("links a same-environment peer thread and calls back with its address", () => {
    const onOpenPeerThread = vi.fn();
    const card = WorkjetMailboxActivityCard({
      model: model(),
      onOpenPeerThread,
    }) as InspectableElement;
    const link = descendants(card.props.children).find((element) => element.type === "button");

    expect(link).toBeDefined();
    (link?.props.onClick as () => void)();
    expect(onOpenPeerThread).toHaveBeenCalledWith({
      environmentId: LOCAL_ENVIRONMENT,
      threadId: "thread-worker",
    });
  });

  it("names but never links a peer on another machine", () => {
    const onOpenPeerThread = vi.fn();
    const card = WorkjetMailboxActivityCard({
      model: model({
        peerIsLocal: false,
        peerEnvironmentId: EnvironmentId.make(REMOTE_ENVIRONMENT),
        disposition: null,
      }),
      onOpenPeerThread,
    }) as InspectableElement;
    const children = descendants(card.props.children);

    expect(children.some((element) => element.type === "button")).toBe(false);
    expect(textContent(card.props.children)).toContain("thread-worker");
    expect(textContent(card.props.children)).toContain("queued");
  });
});

describe("availableDelegationActions", () => {
  it("offers nothing for a plain message or a delegation-less card", () => {
    expect(availableDelegationActions(model(), true)).toEqual([]);
    expect(availableDelegationActions(model({ kind: "task", delegationId: null }), true)).toEqual(
      [],
    );
  });

  it("offers reply, request-review, follow-up, and cancel while running", () => {
    expect(availableDelegationActions(taskModel({ delegationState: "running" }), false)).toEqual([
      "reply",
      "request-review",
      "follow-up",
      "cancel",
    ]);
  });

  it("drops request-review and follow-up once the delegation is no longer running", () => {
    expect(
      availableDelegationActions(taskModel({ delegationState: "review-requested" }), false),
    ).toEqual(["reply", "cancel"]);
  });

  it("offers revise only on changes-requested", () => {
    expect(
      availableDelegationActions(taskModel({ delegationState: "changes-requested" }), false),
    ).toEqual(["reply", "revise", "cancel"]);
    for (const state of ["running", "delivered", "needs-input", "review-requested"] as const) {
      expect(
        availableDelegationActions(taskModel({ delegationState: state }), false),
      ).not.toContain("revise");
    }
  });

  it("offers reassign only on the two pending states, and only with local targets", () => {
    for (const state of ["delivered", "needs-input"] as const) {
      expect(
        availableDelegationActions(taskModel({ delegationState: state }), false, {
          reassignTargetsAvailable: true,
        }),
      ).toEqual(["reply", "reassign", "cancel"]);
      // Without a recipient list there is nowhere to move it to.
      expect(
        availableDelegationActions(taskModel({ delegationState: state }), false),
      ).not.toContain("reassign");
    }
    for (const state of [
      "running",
      "review-requested",
      "changes-requested",
      "completed",
    ] as const) {
      expect(
        availableDelegationActions(taskModel({ delegationState: state }), false, {
          reassignTargetsAvailable: true,
        }),
      ).not.toContain("reassign");
    }
  });

  it("adds the reviewer verdict only on a review-requested card shown to a reviewer", () => {
    expect(
      availableDelegationActions(taskModel({ delegationState: "review-requested" }), true),
    ).toEqual(["reply", "cancel", "approve", "request-changes"]);
    // The same state hides the verdict from a non-reviewer.
    expect(
      availableDelegationActions(taskModel({ delegationState: "review-requested" }), false),
    ).not.toContain("approve");
  });

  it("drops cancel once the delegation reaches a terminal state", () => {
    for (const state of ["completed", "failed", "cancelled", "expired"] as const) {
      expect(availableDelegationActions(taskModel({ delegationState: state }), true)).toEqual([
        "reply",
      ]);
    }
  });
});

describe("parseDelegationReasons", () => {
  it("splits into trimmed, non-blank lines", () => {
    expect(parseDelegationReasons("first\n  second  \n\n third")).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(parseDelegationReasons("   \n  ")).toEqual([]);
  });
});

describe("WorkjetMailboxActivityCard delegation actions", () => {
  it("renders no action row without the dispatch callbacks", () => {
    const card = WorkjetMailboxActivityCard({ model: taskModel() }) as InspectableElement;
    expect(findButton(card.props.children, "reply")).toBeUndefined();
  });

  it("renders the state-appropriate action buttons", () => {
    const card = actionCard({ delegationState: "running" });
    expect(findButton(card.props.children, "reply")).toBeDefined();
    expect(findButton(card.props.children, "request-review")).toBeDefined();
    expect(findButton(card.props.children, "cancel")).toBeDefined();
    expect(findButton(card.props.children, "approve")).toBeUndefined();
  });

  it("dispatches cancel immediately without a popover", () => {
    const onDelegationAction = vi.fn();
    const card = actionCard({ delegationState: "running" }, { onDelegationAction });
    (findButton(card.props.children, "cancel")?.props.onClick as () => void)();
    expect(onDelegationAction).toHaveBeenCalledWith({ kind: "cancel" });
  });

  it("opens the reply popover then dispatches the typed reply body", () => {
    const onActionStateChange = vi.fn();
    const opened = actionCard({ delegationState: "running" }, { onActionStateChange });
    (findButton(opened.props.children, "reply")?.props.onClick as () => void)();
    expect(onActionStateChange).toHaveBeenCalledWith({
      ...EMPTY_DELEGATION_ACTION_STATE,
      open: "reply",
    });

    const onDelegationAction = vi.fn();
    const composing = actionCard(
      { delegationState: "running" },
      {
        onDelegationAction,
        actionState: { ...EMPTY_DELEGATION_ACTION_STATE, open: "reply", text: "Almost there." },
      },
    );
    const submit = descendants(composing.props.children).find(
      (element) => element.props["data-workjet-delegation-submit"] === "reply",
    );
    (submit?.props.onClick as () => void)();
    expect(onDelegationAction).toHaveBeenCalledWith({ kind: "reply", text: "Almost there." });
  });

  it("dispatches request-review with the drafted round and body", () => {
    const onDelegationAction = vi.fn();
    const card = actionCard(
      { delegationState: "running" },
      {
        onDelegationAction,
        actionState: {
          ...EMPTY_DELEGATION_ACTION_STATE,
          open: "request-review",
          text: "Please review.",
          round: 2,
        },
      },
    );
    const submit = descendants(card.props.children).find(
      (element) => element.props["data-workjet-delegation-submit"] === "request-review",
    );
    (submit?.props.onClick as () => void)();
    expect(onDelegationAction).toHaveBeenCalledWith({
      kind: "request-review",
      round: 2,
      text: "Please review.",
    });
  });

  it("dispatches an approve verdict immediately for a reviewer", () => {
    const onDelegationAction = vi.fn();
    const card = actionCard(
      { delegationState: "review-requested" },
      {
        onDelegationAction,
        viewerIsReviewer: true,
        actionState: { ...EMPTY_DELEGATION_ACTION_STATE, round: 3 },
      },
    );
    (findButton(card.props.children, "approve")?.props.onClick as () => void)();
    expect(onDelegationAction).toHaveBeenCalledWith({ kind: "approve", round: 3 });
  });

  it("dispatches a request-changes verdict with parsed reasons", () => {
    const onDelegationAction = vi.fn();
    const card = actionCard(
      { delegationState: "review-requested" },
      {
        onDelegationAction,
        viewerIsReviewer: true,
        actionState: {
          ...EMPTY_DELEGATION_ACTION_STATE,
          open: "request-changes",
          round: 1,
          reasons: "Add a test\nFix the typo",
        },
      },
    );
    const submit = descendants(card.props.children).find(
      (element) => element.props["data-workjet-delegation-submit"] === "request-changes",
    );
    (submit?.props.onClick as () => void)();
    expect(onDelegationAction).toHaveBeenCalledWith({
      kind: "request-changes",
      round: 1,
      reasons: ["Add a test", "Fix the typo"],
    });
  });

  it("dispatches revise immediately without a popover", () => {
    const onDelegationAction = vi.fn();
    const card = actionCard({ delegationState: "changes-requested" }, { onDelegationAction });
    (findButton(card.props.children, "revise")?.props.onClick as () => void)();
    expect(onDelegationAction).toHaveBeenCalledWith({ kind: "revise" });
  });

  it("dispatches a follow-up with an empty note when none was typed", () => {
    const onDelegationAction = vi.fn();
    const card = actionCard(
      { delegationState: "running" },
      {
        onDelegationAction,
        actionState: { ...EMPTY_DELEGATION_ACTION_STATE, open: "follow-up" },
      },
    );
    const submit = descendants(card.props.children).find(
      (element) => element.props["data-workjet-delegation-submit"] === "follow-up",
    );
    // The note is optional, so an empty one must not disable the submit.
    expect(submit?.props.disabled).toBe(false);
    (submit?.props.onClick as () => void)();
    expect(onDelegationAction).toHaveBeenCalledWith({ kind: "follow-up", note: "" });
  });

  it("carries the typed follow-up note through to the dispatcher", () => {
    const onDelegationAction = vi.fn();
    const card = actionCard(
      { delegationState: "running" },
      {
        onDelegationAction,
        actionState: {
          ...EMPTY_DELEGATION_ACTION_STATE,
          open: "follow-up",
          text: "Also check the migration.",
        },
      },
    );
    const submit = descendants(card.props.children).find(
      (element) => element.props["data-workjet-delegation-submit"] === "follow-up",
    );
    (submit?.props.onClick as () => void)();
    expect(onDelegationAction).toHaveBeenCalledWith({
      kind: "follow-up",
      note: "Also check the migration.",
    });
  });

  it("offers the host's local threads in the reassign popover and dispatches the choice", () => {
    const onDelegationAction = vi.fn();
    const card = actionCard(
      { delegationState: "needs-input" },
      {
        onDelegationAction,
        reassignThreads: REASSIGN_THREADS,
        actionState: {
          ...EMPTY_DELEGATION_ACTION_STATE,
          open: "reassign",
          reassignTargetThreadId: "thread-third-worker",
        },
      },
    );
    const select = descendants(card.props.children).find(
      (element) => element.props["aria-label"] === "Reassign to thread",
    );
    // The same recipient list the send panel uses, one option each plus the
    // empty placeholder.
    expect(Children.toArray(select?.props.children).length).toBe(3);
    const submit = descendants(card.props.children).find(
      (element) => element.props["data-workjet-delegation-submit"] === "reassign",
    );
    (submit?.props.onClick as () => void)();
    expect(onDelegationAction).toHaveBeenCalledWith({
      kind: "reassign",
      targetThreadId: "thread-third-worker",
    });
  });

  it("cannot submit a reassignment before a target thread is chosen", () => {
    const card = actionCard(
      { delegationState: "delivered" },
      {
        reassignThreads: REASSIGN_THREADS,
        actionState: { ...EMPTY_DELEGATION_ACTION_STATE, open: "reassign" },
      },
    );
    const submit = descendants(card.props.children).find(
      (element) => element.props["data-workjet-delegation-submit"] === "reassign",
    );
    expect(submit?.props.disabled).toBe(true);
  });

  it("surfaces a bounded refusal reason on the card itself", () => {
    const card = actionCard(
      { delegationState: "needs-input" },
      {
        reassignThreads: REASSIGN_THREADS,
        actionState: {
          ...EMPTY_DELEGATION_ACTION_STATE,
          error: "That delegation can no longer be moved.",
        },
      },
    );
    const note = descendants(card.props.children).find(
      (element) => element.props["data-workjet-delegation-action-error"] === true,
    );
    expect(textContent(note)).toContain("no longer be moved");
  });

  it("hides the reviewer verdict from a non-reviewer on the same card", () => {
    const card = actionCard({ delegationState: "review-requested" }, { viewerIsReviewer: false });
    expect(findButton(card.props.children, "approve")).toBeUndefined();
    expect(findButton(card.props.children, "request-changes")).toBeUndefined();
    expect(findButton(card.props.children, "reply")).toBeDefined();
  });
});
