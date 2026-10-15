import type { ReactElement, ReactNode } from "react";
import { Children, isValidElement } from "react";
import {
  EnvironmentId,
  ThreadId,
  WorkjetMeshWorkspaceId,
  type WorkjetMeshPeerBinding,
  type WorkjetMeshRoster,
} from "@workjet/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildWorkjetDelegateTaskInput,
  buildWorkjetSendHandoffInput,
  buildWorkjetSendMessageInput,
  EMPTY_WORKJET_SEND_DRAFT,
  parseWorkjetScopeFiles,
  resolveWorkjetSendTarget,
  validateWorkjetSendDraft,
  WORKJET_HANDOFF_NOTE_MAX_LENGTH,
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
  applyWorkjetSendRecipient,
  setWorkjetSendTab,
  workjetSendRecipientChoices,
  workjetSendRecipientValue,
  WorkjetSendToWorkerMenuItem,
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
    // Menu triggers carry their button in the `render` prop.
    const rendered = element.props.render;
    found.push(
      element,
      ...(isValidElement(rendered) ? descendants(rendered as ReactNode) : []),
      ...descendants(element.props.children),
    );
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
  it("renders a short German line for a typed mailbox failure", () => {
    expect(
      workjetMailboxFailureMessage({ _tag: "WorkjetMailboxError", reason: "unknown-target" }),
    ).toBe("Empfänger unbekannt");
    expect(
      workjetMailboxFailureMessage({ _tag: "WorkjetMailboxError", reason: "unauthorized" }),
    ).toBe("Nicht berechtigt");
    expect(
      workjetMailboxFailureMessage({ _tag: "WorkjetMailboxError", reason: "target-offline" }),
    ).toBe("Empfänger getrennt");
  });

  it("stays generic for anything that is not a bounded mailbox failure", () => {
    for (const value of [
      null,
      "boom",
      new Error("boom"),
      { _tag: "WorkjetMailboxError", reason: "kaboom" },
      { _tag: "SomethingElse", reason: "unknown-target" },
    ]) {
      expect(workjetMailboxFailureMessage(value)).toBe("Senden fehlgeschlagen");
    }
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

const validHandoffDraft: WorkjetSendDraft = {
  ...EMPTY_WORKJET_SEND_DRAFT,
  tab: "handoff",
  handoffNote: "Continue the transport slice here.",
};

describe("hand-off drafts", () => {
  it("needs no thread id: a handoff addresses a MACHINE", () => {
    // "This machine" is a legitimate target — it takes the local fast path —
    // and neither mode may demand a thread id the receiving side has not made.
    expect(validateWorkjetSendDraft(validHandoffDraft)).toEqual([]);
    expect(
      validateWorkjetSendDraft({
        ...validHandoffDraft,
        recipientMode: "environment",
        targetEnvironmentId: "environment-b",
      }),
    ).toEqual([]);
  });

  it("still requires a machine when another machine is chosen", () => {
    expect(
      validateWorkjetSendDraft({
        ...validHandoffDraft,
        recipientMode: "environment",
        targetEnvironmentId: "  ",
      }),
    ).toEqual(["recipient-environment-required"]);
  });

  it("treats the note as optional but bounded", () => {
    expect(validateWorkjetSendDraft({ ...validHandoffDraft, handoffNote: "" })).toEqual([]);
    expect(
      validateWorkjetSendDraft({
        ...validHandoffDraft,
        handoffNote: "x".repeat(WORKJET_HANDOFF_NOTE_MAX_LENGTH + 1),
      }),
    ).toEqual(["handoff-note-too-long"]);
  });

  it("does not inherit the message requirement from the other two tabs", () => {
    expect(validateWorkjetSendDraft({ ...validHandoffDraft, message: "" })).toEqual([]);
    expect(validateWorkjetSendDraft({ ...EMPTY_WORKJET_SEND_DRAFT, message: "" })).toContain(
      "message-required",
    );
  });
});

describe("buildWorkjetSendHandoffInput", () => {
  it("sends only a machine and an optional note — never a snapshot or digest", () => {
    const input = buildWorkjetSendHandoffInput({
      draft: validHandoffDraft,
      sourceThreadId: SOURCE_THREAD_ID,
      activeEnvironmentId: ENVIRONMENT_ID,
    });
    expect(input).toEqual({
      sourceThreadId: SOURCE_THREAD_ID,
      targetEnvironmentId: ENVIRONMENT_ID,
      note: "Continue the transport slice here.",
    });
    // The snapshot is the server's to compose; a client that could pin one
    // could pin bytes the server never wrote.
    expect(input).not.toHaveProperty("contextSnapshot");
    expect(input).not.toHaveProperty("digest");
    expect(input).not.toHaveProperty("branch");
    expect(input).not.toHaveProperty("targetThreadId");
  });

  it("addresses the chosen remote machine and omits an empty note", () => {
    const input = buildWorkjetSendHandoffInput({
      draft: {
        ...validHandoffDraft,
        recipientMode: "environment",
        targetEnvironmentId: " environment-b ",
        handoffNote: "   ",
      },
      sourceThreadId: SOURCE_THREAD_ID,
      activeEnvironmentId: ENVIRONMENT_ID,
    });
    expect(input.targetEnvironmentId).toBe("environment-b");
    expect(input).not.toHaveProperty("note");
  });
});

// ===============================
// Inline row: Empfänger · Nachricht · Senden, Seltenes im ⋯-Menü
// ===============================

describe("WorkjetSendToWorkerPanelContent inline row", () => {
  const render = (overrides: Partial<WorkjetSendToWorkerPanelProps> = {}) =>
    WorkjetSendToWorkerPanelContent(panelProps(overrides)) as InspectableElement;
  const byLabel = (node: InspectableElement, label: string) =>
    descendants(node.props.children).find((element) => element.props["aria-label"] === label);
  const submitButton = (node: InspectableElement) =>
    descendants(node.props.children).find(
      (element) => typeof element.props.onClick === "function" && element.props.size === "sm",
    );

  it("is one row: recipient dropdown, message, options menu and send", () => {
    const panel = render();
    expect(byLabel(panel, "Empfänger")).toBeDefined();
    expect(byLabel(panel, "Nachricht")).toBeDefined();
    expect(byLabel(panel, "Weitere Optionen")).toBeDefined();
    expect(textContent(panel)).toContain("Senden");
    expect(textContent(panel)).toContain("Worker thread");
  });

  it("never asks for a typed environment id or thread id", () => {
    const labels = descendants(render({ roster: ROSTER }).props.children)
      .map((element) => element.props["aria-label"])
      .filter((label): label is string => typeof label === "string");
    expect(labels.some((label) => /environment id|thread id/i.test(label))).toBe(false);
    expect(labels).not.toContain("Recipient environment id");
  });

  it("hides the task fields until the task kind is chosen", () => {
    const fileSource = { environmentId: "env-a" as EnvironmentId, cwd: "/repo" };
    const hasFilePicker = (tree: unknown) =>
      JSON.stringify(tree, (_key, value) =>
        typeof value === "function" ? undefined : value,
      ).includes('"cwd":"/repo"');
    expect(hasFilePicker(render({ fileSource }))).toBe(false);
    const task = render({ draft: validTaskDraft, fileSource });
    // Dateien werden gewählt, nicht kommagetrennt getippt (Audit B #35).
    expect(hasFilePicker(task)).toBe(true);
    expect(
      JSON.stringify(task, (_k, v) => (typeof v === "function" ? undefined : v)),
    ).not.toContain("kommagetrennt");
    expect(byLabel(task, "Nicht-Ziele")).toBeDefined();
    expect(byLabel(task, "Abnahme")).toBeDefined();
    // Depth, reviews and TTL are menu choices with defaults, never number fields.
    expect(byLabel(task, "Maximum delegation depth")).toBeUndefined();
    expect(textContent(task)).toContain("Laufzeit");
    expect(textContent(task)).toContain("Prüfrunden");
  });

  it("disables send while the draft is invalid and enables it once complete", () => {
    const invalid = submitButton(render({ draft: EMPTY_WORKJET_SEND_DRAFT }));
    expect(invalid?.props.disabled).toBe(true);
    const valid = submitButton(render());
    expect(valid?.props.disabled).toBe(false);
  });

  it("shows the first problem as one short status line once touched", () => {
    const panel = render({ draft: { ...EMPTY_WORKJET_SEND_DRAFT, message: "Hallo" } });
    expect(textContent(panel)).toContain("Empfänger wählen");
    expect(textContent(render({ draft: EMPTY_WORKJET_SEND_DRAFT }))).not.toContain(
      "Empfänger wählen",
    );
  });

  it("reports outcomes without raw envelope ids", () => {
    const queued = textContent(render({ outcome: { _tag: "queued", envelopeId: "envelope-123" } }));
    expect(queued).toContain("In Warteschlange");
    expect(queued).not.toContain("envelope-123");
    const delivered = textContent(
      render({
        outcome: { _tag: "acknowledged", envelopeId: "envelope-9", disposition: "accepted" },
      }),
    );
    expect(delivered).toContain("Zugestellt");
    expect(textContent(render({ outcome: { _tag: "error", message: "kaputt" } }))).toContain(
      "kaputt",
    );
  });

  it("labels the action per kind and while busy", () => {
    expect(textContent(render({ draft: validTaskDraft }))).toContain("Auftrag senden");
    expect(textContent(render({ busy: true }))).toContain("Sendet…");
    expect(textContent(render({ draft: validHandoffDraft }))).toContain("Übergeben");
  });

  it("offers a close button only when the host can close the row", () => {
    expect(byLabel(render(), "Schließen")).toBeUndefined();
    const onClose = vi.fn();
    const close = byLabel(render({ onClose }), "Schließen");
    (close?.props.onClick as () => void)();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("recipient choices", () => {
  it("lists this machine's chats and known peers, newest first", () => {
    const choices = workjetSendRecipientChoices({
      draft: validMessageDraft,
      threads: [{ threadId: "thread-worker", title: "Worker thread" }],
      roster: ROSTER,
    });
    expect(choices.map((choice) => choice.value)).toEqual([
      "thread:thread-worker",
      "peer:environment-newer",
      "peer:environment-older",
    ]);
    // Without a known thread id a peer only takes a handoff.
    expect(choices[1]?.disabledReason).toBe("nur Übergabe");
  });

  it("names a peer by its computer name, otherwise „Rechner ohne Namen“, never a shortened ID", () => {
    const unnamed = workjetSendRecipientChoices({
      draft: validHandoffDraft,
      threads: [],
      roster: ROSTER,
    });
    const peers = unnamed.filter((choice) => choice.group === "peer");
    expect(peers.map((choice) => choice.label)).toEqual([
      "Rechner ohne Namen",
      "Rechner ohne Namen",
    ]);
    for (const choice of peers) expect(choice.label).not.toContain("environment");
    const named = workjetSendRecipientChoices({
      draft: validHandoffDraft,
      threads: [],
      roster: ROSTER,
      computerLabels: { "environment-newer": "gpu3-a4500" },
    });
    expect(named.find((choice) => choice.value === "peer:environment-newer")?.label).toBe(
      "gpu3-a4500",
    );
    expect(named.find((choice) => choice.value === "peer:environment-older")?.label).toBe(
      "Rechner ohne Namen",
    );
  });

  it("makes peers reachable for a handoff and offers a new chat here", () => {
    const choices = workjetSendRecipientChoices({
      draft: validHandoffDraft,
      threads: [{ threadId: "thread-worker", title: "Worker thread" }],
      roster: ROSTER,
    });
    expect(choices[0]?.value).toBe("here");
    expect(choices.every((choice) => choice.disabledReason === null)).toBe(true);
  });

  it("keeps a peer reachable for messages when its thread id is remembered", () => {
    const choices = workjetSendRecipientChoices({
      draft: validMessageDraft,
      threads: [],
      roster: ROSTER,
      rememberedThreadIds: { "environment-newer": "thread-remote" },
    });
    expect(
      choices.find((choice) => choice.value === "peer:environment-newer")?.disabledReason,
    ).toBe(null);
  });

  it("round-trips the dropdown value through the draft", () => {
    const local = applyWorkjetSendRecipient({
      draft: EMPTY_WORKJET_SEND_DRAFT,
      value: "thread:thread-worker",
    });
    expect(local).toMatchObject({ recipientMode: "thread", targetThreadId: "thread-worker" });
    expect(workjetSendRecipientValue(local)).toBe("thread:thread-worker");
    const peer = applyWorkjetSendRecipient({
      draft: validHandoffDraft,
      value: "peer:environment-newer",
    });
    expect(peer).toMatchObject({
      recipientMode: "environment",
      targetEnvironmentId: "environment-newer",
    });
    expect(workjetSendRecipientValue(peer)).toBe("peer:environment-newer");
    const here = applyWorkjetSendRecipient({ draft: peer, value: "here" });
    expect(here.recipientMode).toBe("thread");
    expect(workjetSendRecipientValue(here)).toBe("here");
  });

  it("carries the message along when the kind changes", () => {
    const task = setWorkjetSendTab(validMessageDraft, "task");
    expect(task.prompt).toBe(validMessageDraft.message);
    const handoff = setWorkjetSendTab(validMessageDraft, "handoff");
    expect(handoff.handoffNote).toBe(validMessageDraft.message);
  });
});

describe("the options-menu entry", () => {
  it("opens the inline row instead of a popover", () => {
    const onOpen = vi.fn();
    const item = WorkjetSendToWorkerMenuItem({ onOpen }) as InspectableElement;
    expect(textContent(item)).toContain("An Worker senden");
    (item.props.onClick as () => void)();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(
      (WorkjetSendToWorkerMenuItem({ onOpen, disabled: true }) as InspectableElement).props
        .disabled,
    ).toBe(true);
  });
});

describe("short peer labels", () => {
  it("names both trust levels in a few words without overclaiming", () => {
    expect(workjetPeerTrustLabel("self-signed")).toBe("selbst signiert");
    expect(workjetPeerTrustLabel("tofu")).toBe("beim Erstkontakt gepinnt");
    expect(workjetPeerTrustLabel("tofu")).not.toMatch(/verifiziert|verified/i);
  });

  it("bounds the handoff note like the wire does", () => {
    expect(
      validateWorkjetSendDraft({
        ...validHandoffDraft,
        handoffNote: "x".repeat(WORKJET_HANDOFF_NOTE_MAX_LENGTH + 1),
      }),
    ).toContain("handoff-note-too-long");
  });
});
