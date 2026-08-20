import type { ReactElement, ReactNode } from "react";
import { Children, isValidElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  availableCrossModeActions,
  crossModeApprovalLabel,
  crossModeObjectLabel,
  EMPTY_CROSS_MODE_ACTION_STATE,
  parseWorkjetCrossModeActivity,
  WORKJET_CROSS_MODE_ACTIVITY_KIND_SET,
  WorkjetCrossModeLinkCard,
  type WorkjetCrossModeAction,
  type WorkjetCrossModeActionState,
  type WorkjetCrossModeCardModel,
} from "./WorkjetCrossModeLinkCard";

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

const ctox = {
  schemaVersion: 1,
  instanceId: "paired:manual_pairing:office-1",
  moduleId: "crm",
  objectKind: "deal",
  objectId: "deal_4711",
} as const;

const code = {
  schemaVersion: 1,
  environmentId: "environment-local",
  threadId: "thread-1",
} as const;

const payload = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  linkId: "wjx-0123456789abcdef",
  direction: "to-code",
  ctox,
  code,
  title: "ACME Q3 renewal",
  createdAt: "2026-08-19T10:00:00.000Z",
  ...overrides,
});

const model = (overrides: Partial<WorkjetCrossModeCardModel> = {}): WorkjetCrossModeCardModel => {
  const parsed = parseWorkjetCrossModeActivity("workjet.crossmode.linked", payload());
  if (parsed === null) throw new Error("fixture payload must decode");
  return { ...parsed, ...overrides };
};

const findButton = (children: ReactNode, action: string): InspectableElement | undefined =>
  descendants(children).find(
    (element) => element.props["data-workjet-crossmode-action"] === action,
  );

const actionCard = (
  overrides: Partial<WorkjetCrossModeCardModel> = {},
  extra: {
    readonly onCrossModeAction?: (action: WorkjetCrossModeAction) => void;
    readonly actionState?: WorkjetCrossModeActionState;
  } = {},
) =>
  WorkjetCrossModeLinkCard({
    model: model(overrides),
    onCrossModeAction: extra.onCrossModeAction ?? (() => {}),
    onActionStateChange: () => {},
    actionState: extra.actionState ?? EMPTY_CROSS_MODE_ACTION_STATE,
  }) as InspectableElement;

describe("parseWorkjetCrossModeActivity", () => {
  it("claims exactly the two cross-mode activity kinds", () => {
    expect([...WORKJET_CROSS_MODE_ACTIVITY_KIND_SET].sort()).toEqual([
      "workjet.crossmode.linked",
      "workjet.crossmode.returned",
    ]);
    expect(parseWorkjetCrossModeActivity("workjet.delegation.sent", payload())).toBeNull();
    expect(parseWorkjetCrossModeActivity("thread.message", payload())).toBeNull();
  });

  it("decodes the link activity into typed references and the redacted label", () => {
    const decoded = parseWorkjetCrossModeActivity("workjet.crossmode.linked", payload());
    expect(decoded).not.toBeNull();
    expect(decoded?.kind).toBe("link");
    expect(decoded?.objectId).toBe("deal_4711");
    expect(decoded?.title).toBe("ACME Q3 renewal");
    expect(decoded?.operation).toBeNull();
  });

  it("decodes a return activity with its operation and approval state", () => {
    const decoded = parseWorkjetCrossModeActivity(
      "workjet.crossmode.returned",
      payload({ direction: "to-business-os", operation: "request-review", approval: "pending" }),
    );
    expect(decoded?.kind).toBe("return");
    expect(decoded?.operation).toBe("request-review");
    expect(decoded?.approval).toBe("pending");
  });

  it("degrades to no card rather than crashing on a payload it cannot read", () => {
    expect(
      parseWorkjetCrossModeActivity("workjet.crossmode.linked", { nonsense: true }),
    ).toBeNull();
    expect(
      parseWorkjetCrossModeActivity("workjet.crossmode.linked", payload({ schemaVersion: 99 })),
    ).toBeNull();
  });
});

describe("cross-mode card vocabulary", () => {
  it("renders the object reference an operator can resolve", () => {
    expect(crossModeObjectLabel(model())).toBe("crm/deal/deal_4711");
  });

  it("never claims a dispatched command was applied", () => {
    // The server cannot observe what Business OS did with the command.
    expect(crossModeApprovalLabel("not-required")).toBe("sent");
    expect(crossModeApprovalLabel(null)).toBe("sent");
    expect(crossModeApprovalLabel("pending")).toBe("awaiting approval");
    expect(crossModeApprovalLabel("rejected")).toBe("rejected");
  });
});

describe("availableCrossModeActions", () => {
  it("offers the three reverse operations on the durable backlink card", () => {
    expect([...availableCrossModeActions({ kind: "link" })]).toEqual([
      "submit-result",
      "request-review",
      "follow-up",
    ]);
  });

  it("offers nothing on the trace of an action already taken", () => {
    expect([...availableCrossModeActions({ kind: "return" })]).toEqual([]);
  });
});

describe("WorkjetCrossModeLinkCard", () => {
  it("renders the redacted title and the object reference, and no record", () => {
    const card = WorkjetCrossModeLinkCard({ model: model() }) as InspectableElement;
    const text = textContent(card);
    expect(text).toContain("Linked to");
    expect(text).toContain("ACME Q3 renewal");
    expect(text).toContain("crm/deal/deal_4711");
  });

  it("stays display-only without the controlled action props", () => {
    const card = WorkjetCrossModeLinkCard({ model: model() }) as InspectableElement;
    expect(
      descendants(card.props.children).some(
        (element) => element.props["data-workjet-crossmode-actions"] !== undefined,
      ),
    ).toBe(false);
  });

  it("offers `Return to Business OS` only when the host can select the counterpart", () => {
    const withoutHost = WorkjetCrossModeLinkCard({ model: model() }) as InspectableElement;
    expect(
      descendants(withoutHost.props.children).some(
        (element) => element.props["data-workjet-crossmode-open"] !== undefined,
      ),
    ).toBe(false);

    const onOpenBusinessOsObject = vi.fn();
    const withHost = WorkjetCrossModeLinkCard({
      model: model(),
      onOpenBusinessOsObject,
    }) as InspectableElement;
    const open = descendants(withHost.props.children).find(
      (element) => element.props["data-workjet-crossmode-open"] !== undefined,
    );
    expect(open).toBeDefined();
    (open?.props["onClick"] as () => void)();
    expect(onOpenBusinessOsObject).toHaveBeenCalledWith({
      instanceId: ctox.instanceId,
      moduleId: ctox.moduleId,
      objectKind: ctox.objectKind,
      objectId: ctox.objectId,
    });
  });

  it("shows the approval state on a return card and not on the link card", () => {
    const returned = WorkjetCrossModeLinkCard({
      model: model({ kind: "return", operation: "request-review", approval: "pending" }),
    }) as InspectableElement;
    expect(textContent(returned)).toContain("awaiting approval");

    expect(textContent(WorkjetCrossModeLinkCard({ model: model() }))).not.toContain(
      "awaiting approval",
    );
  });
});

describe("WorkjetCrossModeLinkCard actions", () => {
  it("renders one button per reverse operation on a linked thread", () => {
    const card = actionCard();
    for (const action of ["submit-result", "request-review", "follow-up"]) {
      expect(findButton(card.props.children, action)).toBeDefined();
    }
  });

  it("renders no action buttons on a return trace", () => {
    const card = actionCard({ kind: "return", operation: "submit-result" });
    expect(findButton(card.props.children, "submit-result")).toBeUndefined();
  });

  it("opens a draft instead of dispatching immediately: evidence is always required", () => {
    const onCrossModeAction = vi.fn();
    const onActionStateChange = vi.fn();
    const card = WorkjetCrossModeLinkCard({
      model: model(),
      onCrossModeAction,
      onActionStateChange,
      actionState: EMPTY_CROSS_MODE_ACTION_STATE,
    }) as InspectableElement;

    (findButton(card.props.children, "follow-up")?.props["onClick"] as () => void)();
    expect(onCrossModeAction).not.toHaveBeenCalled();
    expect(onActionStateChange).toHaveBeenCalledWith({
      ...EMPTY_CROSS_MODE_ACTION_STATE,
      open: "follow-up",
    });
  });

  it("dispatches a result with its outcome and the evidence summary", () => {
    const onCrossModeAction = vi.fn();
    const card = actionCard(
      {},
      {
        onCrossModeAction,
        actionState: {
          open: "submit-result",
          summary: "Renewal rule shipped.",
          outcome: "completed",
          error: null,
        },
      },
    );
    const submit = descendants(card.props.children).find(
      (element) => element.props["data-workjet-crossmode-submit"] === "submit-result",
    );
    (submit?.props["onClick"] as () => void)();
    expect(onCrossModeAction).toHaveBeenCalledWith({
      kind: "submit-result",
      linkId: "wjx-0123456789abcdef",
      summary: "Renewal rule shipped.",
      outcome: "completed",
    });
  });

  it("dispatches a review request and a follow-up with the same evidence summary", () => {
    for (const operation of ["request-review", "follow-up"] as const) {
      const onCrossModeAction = vi.fn();
      const card = actionCard(
        {},
        {
          onCrossModeAction,
          actionState: {
            open: operation,
            summary: "Please look.",
            outcome: "completed",
            error: null,
          },
        },
      );
      const submit = descendants(card.props.children).find(
        (element) => element.props["data-workjet-crossmode-submit"] === operation,
      );
      (submit?.props["onClick"] as () => void)();
      expect(onCrossModeAction).toHaveBeenCalledWith({
        kind: operation,
        linkId: "wjx-0123456789abcdef",
        summary: "Please look.",
      });
    }
  });

  it("refuses to submit an empty evidence summary", () => {
    const card = actionCard(
      {},
      {
        actionState: { open: "request-review", summary: "   ", outcome: "completed", error: null },
      },
    );
    const submit = descendants(card.props.children).find(
      (element) => element.props["data-workjet-crossmode-submit"] === "request-review",
    );
    expect(submit?.props["disabled"]).toBe(true);
  });

  it("shows a bounded refusal where the action was taken", () => {
    const card = actionCard(
      {},
      {
        actionState: {
          ...EMPTY_CROSS_MODE_ACTION_STATE,
          error: "The CTOX command surface is not reachable from this server.",
        },
      },
    );
    const error = descendants(card.props.children).find(
      (element) => element.props["data-workjet-crossmode-action-error"] !== undefined,
    );
    expect(textContent(error)).toContain("not reachable");
  });
});
