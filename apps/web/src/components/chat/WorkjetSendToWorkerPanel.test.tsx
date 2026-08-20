import type { ReactElement, ReactNode } from "react";
import { Children, isValidElement } from "react";
import {
  EnvironmentId,
  ThreadId,
  WorkjetMeshWorkspaceId,
  type WorkjetMeshPeerBinding,
  type WorkjetMeshRoster,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildWorkjetDelegateTaskInput,
  buildWorkjetSendMessageInput,
  EMPTY_WORKJET_SEND_DRAFT,
  parseWorkjetScopeFiles,
  resolveWorkjetSendTarget,
  validateWorkjetSendDraft,
  WORKJET_MAX_TTL_SECONDS,
  WORKJET_MESSAGE_MAX_LENGTH,
  WORKJET_MIN_TTL_SECONDS,
  WORKJET_SEND_FIELD_ERROR_MESSAGES,
  formatWorkjetFirstContact,
  orderWorkjetRosterPeers,
  workjetPeerTrustLabel,
  rememberWorkjetRemoteThreadId,
  selectWorkjetRosterPeer,
  workjetMailboxFailureMessage,
  WorkjetSendToWorkerPanelControl,
  WorkjetSendToWorkerPanelContent,
  type WorkjetSendDraft,
  type WorkjetSendToWorkerPanelProps,
} from "./WorkjetSendToWorkerPanel";

type InspectableElement = ReactElement<
  Readonly<Record<string, unknown>> & { readonly children?: ReactNode }
>;

function descendants(node: ReactNode): InspectableElement[] {
  const found: InspectableElement[] = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const element = child as InspectableElement;
    found.push(element, ...descendants(element.props.children));
  }
  return found;
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(" ");
  if (isValidElement(node)) return textContent((node as InspectableElement).props.children);
  return "";
}

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const SOURCE_THREAD_ID = ThreadId.make("thread-orchestrator");

const validMessageDraft: WorkjetSendDraft = {
  ...EMPTY_WORKJET_SEND_DRAFT,
  targetThreadId: "thread-worker",
  message: "Please look at the failing test.",
};

const validTaskDraft: WorkjetSendDraft = {
  ...validMessageDraft,
  tab: "task",
  prompt: "Fix the flaky mailbox store test.",
  scopeFiles: "apps/server/src/workjet/mailbox/WorkjetMailboxStore.ts\n",
  nonGoals: "No contract changes.",
  acceptance: "The focused test run is green.",
};

const panelProps = (
  overrides: Partial<WorkjetSendToWorkerPanelProps> = {},
): WorkjetSendToWorkerPanelProps => ({
  draft: validMessageDraft,
  threads: [{ threadId: "thread-worker", title: "Worker thread" }],
  busy: false,
  outcome: null,
  onDraftChange: () => undefined,
  onSubmit: () => undefined,
  ...overrides,
});

describe("parseWorkjetScopeFiles", () => {
  it("keeps repository-relative paths, drops blanks, and deduplicates", () => {
    const parsed = parseWorkjetScopeFiles("  a/b.ts \n\n a/b.ts \n c/d.ts \n");

    expect(parsed.files).toEqual(["a/b.ts", "c/d.ts"]);
    expect(parsed.invalid).toEqual([]);
  });

  it("reports absolute, traversing, and backslashed paths as invalid", () => {
    const parsed = parseWorkjetScopeFiles("/etc/passwd\n../outside.ts\na\\b.ts\nok/file.ts");

    expect(parsed.files).toEqual(["ok/file.ts"]);
    expect(parsed.invalid).toEqual(["/etc/passwd", "../outside.ts", "a\\b.ts"]);
  });
});

describe("validateWorkjetSendDraft", () => {
  it("accepts a complete message draft and a complete task draft", () => {
    expect(validateWorkjetSendDraft(validMessageDraft)).toEqual([]);
    expect(validateWorkjetSendDraft(validTaskDraft)).toEqual([]);
  });

  it("requires a recipient in whichever mode the draft is in", () => {
    expect(validateWorkjetSendDraft({ ...validMessageDraft, targetThreadId: " " })).toContain(
      "recipient-thread-required",
    );
    expect(
      validateWorkjetSendDraft({
        ...validMessageDraft,
        recipientMode: "environment",
        targetEnvironmentId: "",
      }),
    ).toContain("recipient-environment-required");
    expect(
      validateWorkjetSendDraft({
        ...validMessageDraft,
        recipientMode: "environment",
        targetEnvironmentId: "environment-remote",
      }),
    ).toEqual([]);
  });

  it("requires a nonblank message inside the wire bound", () => {
    expect(validateWorkjetSendDraft({ ...validMessageDraft, message: "   " })).toContain(
      "message-required",
    );
    expect(
      validateWorkjetSendDraft({
        ...validMessageDraft,
        message: "x".repeat(WORKJET_MESSAGE_MAX_LENGTH + 1),
      }),
    ).toContain("message-too-long");
  });

  it("ignores every task field while the draft is a plain message", () => {
    expect(
      validateWorkjetSendDraft({
        ...validMessageDraft,
        prompt: "",
        scopeFiles: "/absolute",
        acceptance: "",
        nonGoals: "",
        maxDepth: 99,
      }),
    ).toEqual([]);
  });

  it("requires prompt, scope, non-goals and acceptance on the task tab", () => {
    const errors = validateWorkjetSendDraft({
      ...validTaskDraft,
      prompt: " ",
      scopeFiles: "",
      nonGoals: "",
      acceptance: "",
    });

    expect(errors).toEqual([
      "prompt-required",
      "scope-required",
      "non-goals-required",
      "acceptance-required",
    ]);
  });

  it("flags a scope line the repository-path contract refuses", () => {
    expect(
      validateWorkjetSendDraft({ ...validTaskDraft, scopeFiles: "ok/file.ts\n../escape.ts" }),
    ).toEqual(["scope-invalid-path"]);
  });

  it("holds the budget inside the contract bounds", () => {
    expect(validateWorkjetSendDraft({ ...validTaskDraft, maxDepth: 0 })).toContain(
      "budget-depth-out-of-range",
    );
    expect(validateWorkjetSendDraft({ ...validTaskDraft, maxDepth: 17 })).toContain(
      "budget-depth-out-of-range",
    );
    expect(validateWorkjetSendDraft({ ...validTaskDraft, maxReviewRounds: -1 })).toContain(
      "budget-review-rounds-out-of-range",
    );
    expect(validateWorkjetSendDraft({ ...validTaskDraft, maxReviewRounds: 0 })).toEqual([]);
    expect(
      validateWorkjetSendDraft({ ...validTaskDraft, ttlSeconds: WORKJET_MIN_TTL_SECONDS - 1 }),
    ).toContain("budget-ttl-out-of-range");
    expect(
      validateWorkjetSendDraft({ ...validTaskDraft, ttlSeconds: WORKJET_MAX_TTL_SECONDS + 1 }),
    ).toContain("budget-ttl-out-of-range");
  });

  it("has a message for every error it can raise", () => {
    for (const error of validateWorkjetSendDraft({
      ...EMPTY_WORKJET_SEND_DRAFT,
      tab: "task",
      scopeFiles: "/absolute",
      maxDepth: 0,
      maxReviewRounds: -1,
      ttlSeconds: 0,
    })) {
      expect(WORKJET_SEND_FIELD_ERROR_MESSAGES[error].length).toBeGreaterThan(0);
    }
  });
});

describe("workjet send payloads", () => {
  it("addresses a same-machine recipient with the active environment", () => {
    expect(resolveWorkjetSendTarget(validMessageDraft, ENVIRONMENT_ID)).toEqual({
      environmentId: ENVIRONMENT_ID,
      threadId: "thread-worker",
    });
  });

  it("addresses another machine with the typed environment and thread id", () => {
    expect(
      resolveWorkjetSendTarget(
        {
          ...validMessageDraft,
          recipientMode: "environment",
          targetEnvironmentId: " environment-remote ",
          targetThreadId: " thread-remote ",
        },
        ENVIRONMENT_ID,
      ),
    ).toEqual({ environmentId: "environment-remote", threadId: "thread-remote" });
  });

  it("builds a trimmed inline message payload naming the source thread", () => {
    expect(
      buildWorkjetSendMessageInput({
        draft: { ...validMessageDraft, message: "  hello worker  " },
        sourceThreadId: SOURCE_THREAD_ID,
        activeEnvironmentId: ENVIRONMENT_ID,
      }),
    ).toEqual({
      sourceThreadId: SOURCE_THREAD_ID,
      targetEnvironmentId: ENVIRONMENT_ID,
      targetThreadId: "thread-worker",
      body: { _tag: "inline", text: "hello worker" },
    });
  });

  it("builds the delegation payload from the parsed scope and budget", () => {
    expect(
      buildWorkjetDelegateTaskInput({
        draft: validTaskDraft,
        sourceThreadId: SOURCE_THREAD_ID,
        activeEnvironmentId: ENVIRONMENT_ID,
      }),
    ).toEqual({
      sourceThreadId: SOURCE_THREAD_ID,
      targetEnvironmentId: ENVIRONMENT_ID,
      targetThreadId: "thread-worker",
      prompt: "Fix the flaky mailbox store test.",
      scope: {
        files: ["apps/server/src/workjet/mailbox/WorkjetMailboxStore.ts"],
        nonGoals: "No contract changes.",
      },
      acceptance: "The focused test run is green.",
      budget: { maxDepth: 2, maxReviewRounds: 1, ttlSeconds: 3_600 },
      ttlSeconds: 3_600,
    });
  });
});

describe("workjetMailboxFailureMessage", () => {
  it("renders the contract's own sentence for a typed mailbox failure", () => {
    expect(
      workjetMailboxFailureMessage({ _tag: "WorkjetMailboxError", reason: "unknown-target" }),
    ).toBe("The mailbox target address is unknown.");
    expect(
      workjetMailboxFailureMessage({ _tag: "WorkjetMailboxError", reason: "unauthorized" }),
    ).toBe("The mailbox operation is not authorized for this environment.");
  });

  it("stays generic for anything that is not a bounded mailbox failure", () => {
    for (const value of [
      null,
      "boom",
      new Error("boom"),
      { _tag: "WorkjetMailboxError", reason: "kaboom" },
      { _tag: "SomethingElse", reason: "unknown-target" },
    ]) {
      expect(workjetMailboxFailureMessage(value)).toBe("The Workjet mailbox send failed.");
    }
  });
});

describe("WorkjetSendToWorkerPanelContent", () => {
  const render = (overrides: Partial<WorkjetSendToWorkerPanelProps> = {}) =>
    WorkjetSendToWorkerPanelContent(panelProps(overrides)) as InspectableElement;

  it("shows both tabs and marks the active one", () => {
    const tabs = descendants(render().props.children).filter(
      (element) => element.props.role === "tab",
    );

    expect(tabs.map((tab) => textContent(tab.props.children))).toEqual([
      "Message",
      "Message + Task",
    ]);
    expect(tabs.map((tab) => tab.props["aria-selected"])).toEqual([true, false]);
  });

  it("hides every task field until the task tab is chosen", () => {
    const messageLabels = descendants(render().props.children).map(
      (element) => element.props["aria-label"],
    );
    expect(messageLabels).not.toContain("Task prompt");
    expect(messageLabels).not.toContain("Scope files, one per line");

    const taskLabels = descendants(render({ draft: validTaskDraft }).props.children).map(
      (element) => element.props["aria-label"],
    );
    expect(taskLabels).toContain("Task prompt");
    expect(taskLabels).toContain("Scope files, one per line");
    expect(taskLabels).toContain("Acceptance");
    expect(taskLabels).toContain("Maximum delegation depth");
    expect(taskLabels).toContain("Maximum review rounds");
    expect(taskLabels).toContain("Time to live in seconds");
  });

  it("constrains the budget inputs to the contract bounds", () => {
    const inputs = new Map(
      descendants(render({ draft: validTaskDraft }).props.children)
        .filter((element) => typeof element.props["aria-label"] === "string")
        .map((element) => [element.props["aria-label"] as string, element.props]),
    );

    expect(inputs.get("Maximum delegation depth")).toMatchObject({ min: 1, max: 16 });
    expect(inputs.get("Maximum review rounds")).toMatchObject({ min: 0, max: 16 });
    expect(inputs.get("Time to live in seconds")).toMatchObject({
      min: WORKJET_MIN_TTL_SECONDS,
      max: WORKJET_MAX_TTL_SECONDS,
    });
  });

  it("lists the known threads for a same-machine recipient", () => {
    const select = descendants(render().props.children).find(
      (element) => element.props["aria-label"] === "Recipient thread",
    );

    expect(select?.type).toBe("select");
    expect(textContent(select?.props.children)).toContain("Worker thread");
  });

  it("offers a free-text environment id and says the send is queued", () => {
    const panel = render({
      draft: { ...validMessageDraft, recipientMode: "environment", targetEnvironmentId: "env-b" },
    });
    const children = descendants(panel.props.children);

    expect(
      children.some((element) => element.props["aria-label"] === "Recipient environment id"),
    ).toBe(true);
    expect(textContent(panel.props.children)).toContain("Queued until the mesh delivers.");
  });

  it("disables submit while the draft is invalid and enables it once complete", () => {
    const submitOf = (props: Partial<WorkjetSendToWorkerPanelProps>) =>
      descendants(render(props).props.children).find(
        (element) => typeof element.props.onClick === "function" && element.props.onClick !== null,
      );

    const invalid = descendants(
      render({ draft: { ...validMessageDraft, message: "" } }).props.children,
    ).filter((element) => textContent(element.props.children) === "Send message");
    expect(invalid[0]?.props.disabled).toBe(true);

    const valid = descendants(render().props.children).filter(
      (element) => textContent(element.props.children) === "Send message",
    );
    expect(valid[0]?.props.disabled).toBe(false);
    expect(submitOf({})).toBeDefined();
  });

  it("labels the submit for the task tab and while busy", () => {
    expect(textContent(render({ draft: validTaskDraft }).props.children)).toContain("Send task");
    expect(textContent(render({ busy: true }).props.children)).toContain("Sending…");
  });

  it("calls back with the patched draft when a tab is switched", () => {
    const onDraftChange = vi.fn();
    const taskTab = descendants(render({ onDraftChange }).props.children).find(
      (element) => textContent(element.props.children) === "Message + Task",
    );

    (taskTab?.props.onClick as () => void)();
    expect(onDraftChange).toHaveBeenCalledWith({ ...validMessageDraft, tab: "task" });
  });

  it("renders each send outcome inline", () => {
    expect(
      textContent(render({ outcome: { _tag: "queued", envelopeId: "wjm-1" } }).props.children),
    ).toContain("Queued as wjm-1.");
    expect(
      textContent(
        render({
          outcome: { _tag: "acknowledged", envelopeId: "wjm-2", disposition: "accepted-new" },
        }).props.children,
      ),
    ).toContain("Delivered as wjm-2 (accepted-new).");
    const failed = render({
      outcome: { _tag: "error", message: "The mailbox target address is unknown." },
    });
    expect(textContent(failed.props.children)).toContain("The mailbox target address is unknown.");
    expect(
      descendants(failed.props.children).some(
        (element) => element.props["data-workjet-send-outcome"] === "error",
      ),
    ).toBe(true);
  });
});

// ===============================
// Cross-machine recipient roster
// ===============================

const rosterPeer = (
  environmentId: string,
  firstSeenAt: string,
  sealed = true,
  binding: WorkjetMeshPeerBinding = "self-signed",
) => ({
  schemaVersion: 1 as const,
  workspaceId: WorkjetMeshWorkspaceId.make("workjet-mesh-peer"),
  environmentId: EnvironmentId.make(environmentId),
  firstSeenAt,
  sealedDeliveryReady: sealed,
  binding,
});

const ROSTER: WorkjetMeshRoster = {
  schemaVersion: 1 as const,
  local: {
    schemaVersion: 1 as const,
    workspaceId: WorkjetMeshWorkspaceId.make("workjet-mesh-local"),
    environmentId: ENVIRONMENT_ID,
  },
  peers: [
    rosterPeer("environment-older", "2026-08-01T09:00:00.000Z"),
    rosterPeer("environment-newer", "2026-08-18T10:00:00.000Z", false),
  ],
  truncated: false,
};

describe("roster helpers", () => {
  it("orders peers by most recent first contact and tolerates a missing roster", () => {
    expect(orderWorkjetRosterPeers(ROSTER).map((peer) => peer.environmentId)).toEqual([
      "environment-newer",
      "environment-older",
    ]);
    expect(orderWorkjetRosterPeers(null)).toEqual([]);
  });

  it("renders a first-contact pin as a date, never as a liveness claim", () => {
    expect(formatWorkjetFirstContact("2026-08-18T10:00:00.000Z")).toBe("2026-08-18");
  });

  it("fills the address from a peer and prefills its last used thread id", () => {
    const fresh = selectWorkjetRosterPeer({
      draft: EMPTY_WORKJET_SEND_DRAFT,
      environmentId: "environment-newer",
      rememberedThreadIds: undefined,
    });
    expect(fresh).toMatchObject({
      recipientMode: "environment",
      targetEnvironmentId: "environment-newer",
      targetThreadId: "",
    });

    const remembered = selectWorkjetRosterPeer({
      draft: EMPTY_WORKJET_SEND_DRAFT,
      environmentId: "environment-newer",
      rememberedThreadIds: { "environment-newer": "thread-remote" },
    });
    expect(remembered.targetThreadId).toBe("thread-remote");
  });

  it("remembers a remote thread id per peer and ignores blanks and local drafts", () => {
    const remote: WorkjetSendDraft = {
      ...EMPTY_WORKJET_SEND_DRAFT,
      recipientMode: "environment",
      targetEnvironmentId: "environment-newer",
      targetThreadId: "thread-remote",
    };
    expect(rememberWorkjetRemoteThreadId({}, remote)).toEqual({
      "environment-newer": "thread-remote",
    });
    // A blank id must not erase a usable memory.
    expect(
      rememberWorkjetRemoteThreadId(
        { "environment-newer": "thread-remote" },
        { ...remote, targetThreadId: "" },
      ),
    ).toEqual({ "environment-newer": "thread-remote" });
    // A same-machine draft is not a remote address.
    expect(rememberWorkjetRemoteThreadId({}, { ...remote, recipientMode: "thread" })).toEqual({});
  });
});

describe("WorkjetSendToWorkerPanelContent remote recipients", () => {
  const remoteDraft: WorkjetSendDraft = {
    ...validMessageDraft,
    recipientMode: "environment",
    targetEnvironmentId: "",
    targetThreadId: "",
  };
  const render = (overrides: Partial<WorkjetSendToWorkerPanelProps> = {}) =>
    WorkjetSendToWorkerPanelContent(
      panelProps({ draft: remoteDraft, roster: ROSTER, ...overrides }),
    ) as InspectableElement;

  it("groups the roster peers under a remote environments group, newest first", () => {
    const select = descendants(render().props.children).find(
      (element) => element.props["aria-label"] === "Remote environment",
    );
    const group = descendants(select?.props.children).find(
      (element) => element.type === "optgroup",
    );

    expect(group?.props.label).toBe("Remote environments");
    const options = descendants(group?.props.children).filter(
      (element) => element.type === "option",
    );
    expect(options.map((option) => option.props.value)).toEqual([
      "environment-newer",
      "environment-older",
    ]);
    // The pin date is shown as first contact, never as "last seen" or "online".
    expect(textContent(group?.props.children)).toContain("first contact 2026-08-18");
    expect(textContent(render().props.children)).not.toContain("online");
  });

  it("fills the address from a selected peer and drops the free-text field", () => {
    const changes: WorkjetSendDraft[] = [];
    const panel = render({ onDraftChange: (draft) => changes.push(draft) });
    const select = descendants(panel.props.children).find(
      (element) => element.props["aria-label"] === "Remote environment",
    );

    (select?.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "environment-newer" },
    });
    expect(changes[0]).toMatchObject({
      recipientMode: "environment",
      targetEnvironmentId: "environment-newer",
    });

    const selected = render({
      draft: { ...remoteDraft, targetEnvironmentId: "environment-newer" },
    });
    const labels = descendants(selected.props.children).map(
      (element) => element.props["aria-label"],
    );
    expect(labels).not.toContain("Recipient environment id");
    expect(labels).toContain("Recipient thread id on the other machine");
  });

  it("keeps the free-text environment id for a machine the roster does not know", () => {
    const labels = descendants(
      render({ draft: { ...remoteDraft, targetEnvironmentId: "environment-unknown" } }).props
        .children,
    ).map((element) => element.props["aria-label"]);
    expect(labels).toContain("Recipient environment id");
  });

  it("requires the remote thread id and says why it cannot be picked", () => {
    const panel = render({
      draft: { ...remoteDraft, targetEnvironmentId: "environment-newer" },
    });
    expect(
      validateWorkjetSendDraft({ ...remoteDraft, targetEnvironmentId: "environment-newer" }),
    ).toContain("recipient-remote-thread-required");
    // The error is rendered through `ErrorNote`, so assert on the note the
    // panel actually raises rather than on flattened text.
    expect(
      descendants(panel.props.children).some(
        (element) => element.props.error === "recipient-remote-thread-required",
      ),
    ).toBe(true);
    expect(WORKJET_SEND_FIELD_ERROR_MESSAGES["recipient-remote-thread-required"]).toBe(
      "Enter the thread id on the other machine.",
    );
    expect(textContent(panel.props.children)).toContain("cannot list another machine");
  });

  it("says the machine has no peers yet instead of inventing one", () => {
    const empty = render({ roster: { ...ROSTER, peers: [] } });
    expect(textContent(empty.props.children)).toContain(
      "This machine has not exchanged mail with any peer yet.",
    );
    expect(
      descendants(empty.props.children).some(
        (element) => element.props["aria-label"] === "Remote environment",
      ),
    ).toBe(false);
  });

  it("distinguishes an unread roster from an empty one", () => {
    const unavailable = render({ roster: null });
    expect(textContent(unavailable.props.children)).toContain(
      "The mesh roster is not available yet.",
    );
    expect(
      descendants(unavailable.props.children).some(
        (element) => element.props["aria-label"] === "Recipient environment id",
      ),
    ).toBe(true);
  });

  it("reports the sealing state of the selected peer and roster truncation", () => {
    const unsealed = render({
      draft: { ...remoteDraft, targetEnvironmentId: "environment-newer" },
      roster: { ...ROSTER, truncated: true },
    });
    const text = textContent(unsealed.props.children);
    expect(text).toContain("No encryption key pinned yet");
    expect(text).toContain("More peers are pinned than this list shows.");

    expect(
      textContent(
        render({ draft: { ...remoteDraft, targetEnvironmentId: "environment-older" } }).props
          .children,
      ),
    ).toContain("encryption key is pinned");
  });

  it("states each peer's trust level instead of implying they are all verified", () => {
    // `sealedDeliveryReady` reads like an assurance about WHOSE machine this is
    // and is not one, so the panel says the second thing separately.
    const bound = textContent(
      render({ draft: { ...remoteDraft, targetEnvironmentId: "environment-older" } }).props
        .children,
    );
    expect(bound).toContain("signed for its own keys");
    // Even the strongest level the mesh can establish is qualified: it does not
    // say "verified", because first-contact impersonation remains open.
    expect(bound).toContain("claimed this environment id first");
    expect(bound).not.toContain("verified");

    const tofuRoster: WorkjetMeshRoster = {
      ...ROSTER,
      peers: [rosterPeer("environment-tofu", "2026-08-02T09:00:00.000Z", true, "tofu")],
    };
    const unbound = textContent(
      render({
        draft: { ...remoteDraft, targetEnvironmentId: "environment-tofu" },
        roster: tofuRoster,
      }).props.children,
    );
    expect(unbound).toContain("without a signed key binding");
    expect(unbound).toContain("CTOX room membership alone");
  });

  it("labels both trust levels without overclaiming either", () => {
    expect(workjetPeerTrustLabel("tofu")).toContain("room membership alone");
    expect(workjetPeerTrustLabel("self-signed")).toContain("no other machine in the room");
  });

  it("leaves the same-machine thread list untouched", () => {
    const local = WorkjetSendToWorkerPanelContent(
      panelProps({ roster: ROSTER }),
    ) as InspectableElement;
    const select = descendants(local.props.children).find(
      (element) => element.props["aria-label"] === "Recipient thread",
    );
    expect(textContent(select?.props.children)).toContain("Worker thread");
    expect(
      descendants(local.props.children).some(
        (element) => element.props["aria-label"] === "Remote environment",
      ),
    ).toBe(false);
  });
});

describe("WorkjetSendToWorkerPanel compact variant", () => {
  const trigger = (props: Partial<WorkjetSendToWorkerPanelProps>) => {
    const control = WorkjetSendToWorkerPanelControl(panelProps(props)) as InspectableElement;
    const [popoverTrigger, popup] = Children.toArray(control.props.children).filter(isValidElement);
    return {
      trigger: popoverTrigger as InspectableElement,
      popup: popup as InspectableElement,
    };
  };

  it("renders the labelled control by default", () => {
    const { trigger: control } = trigger({});

    expect(control.props["data-workjet-send-control-compact"]).toBe("false");
    const rendered = control.props.render as InspectableElement;
    expect(rendered.props["aria-label"]).toBe("Send to worker");
    expect(textContent(control.props.children)).toContain("Send to worker");
  });

  it("collapses to an icon button that still names itself, keeping the same popover", () => {
    const { trigger: control, popup } = trigger({ compact: true });

    expect(control.props["data-workjet-send-control-compact"]).toBe("true");
    const rendered = control.props.render as InspectableElement;
    // The visible label goes; the ACCESSIBLE name does not.
    expect(rendered.props["aria-label"]).toBe("Send to worker");
    const label = descendants(control.props.children).find(
      (element) => textContent(element) === "Send to worker",
    );
    expect(label?.props.className).toBe("sr-only");
    // The popover still holds the complete panel, not a reduced one.
    const [content] = Children.toArray(popup.props.children).filter(isValidElement);
    expect((content as InspectableElement).type).toBe(WorkjetSendToWorkerPanelContent);
  });

  it("gates identically in both variants: a disabled host disables the trigger", () => {
    expect(trigger({ disabled: true }).trigger.props.disabled).toBe(true);
    expect(trigger({ disabled: true, compact: true }).trigger.props.disabled).toBe(true);
    expect(trigger({ compact: true }).trigger.props.disabled).toBe(false);
  });
});
