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
  delegationStateToneClass,
  dispositionBadgeLabel,
  parseWorkjetMailboxActivity,
  shortEnvironmentId,
  WORKJET_MAILBOX_ACTIVITY_KIND_SET,
  WorkjetMailboxActivityCard,
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
  ...overrides,
});

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
