// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  WORKJET_CROSS_MODE_ACTIVITY_KINDS,
  WORKJET_CROSS_MODE_CONTEXT_MAX_BYTES,
  WORKJET_CROSS_MODE_LINK_LIST_MAX,
  WORKJET_CROSS_MODE_SCHEMA_VERSION,
  WorkjetCrossModeActivityPayload,
  WorkjetCrossModeCodeRef,
  WorkjetCrossModeCtoxRef,
  WorkjetCrossModeError,
  WorkjetCrossModeEvidence,
  WorkjetCrossModeLink,
  WorkjetCrossModeListLinksRpcInput,
  WorkjetCrossModeOpenInCodeRpcInput,
  WorkjetCrossModeOpenInCodeRpcResult,
  WorkjetCrossModePresentation,
  WorkjetCrossModeSubmitRpcInput,
  WorkjetCrossModeSubmitRpcResult,
} from "./workjetCrossMode.ts";

const decodeCtox = Schema.decodeUnknownSync(WorkjetCrossModeCtoxRef);
const decodeCode = Schema.decodeUnknownSync(WorkjetCrossModeCodeRef);
const decodePresentation = Schema.decodeUnknownSync(WorkjetCrossModePresentation);
const decodeLink = Schema.decodeUnknownSync(WorkjetCrossModeLink);
const encodeLink = Schema.encodeUnknownSync(WorkjetCrossModeLink);
const decodeOpenInput = Schema.decodeUnknownSync(WorkjetCrossModeOpenInCodeRpcInput);
const decodeOpenResult = Schema.decodeUnknownSync(WorkjetCrossModeOpenInCodeRpcResult);
const decodeSubmitInput = Schema.decodeUnknownSync(WorkjetCrossModeSubmitRpcInput);
const decodeSubmitResult = Schema.decodeUnknownSync(WorkjetCrossModeSubmitRpcResult);
const decodeEvidence = Schema.decodeUnknownSync(WorkjetCrossModeEvidence);
const decodeActivity = Schema.decodeUnknownSync(WorkjetCrossModeActivityPayload);
const decodeListInput = Schema.decodeUnknownSync(WorkjetCrossModeListLinksRpcInput);

const version = WORKJET_CROSS_MODE_SCHEMA_VERSION;
const control = String.fromCharCode(0);

const ctox = {
  schemaVersion: version,
  instanceId: "paired:manual_pairing:office-1",
  moduleId: "crm",
  objectKind: "deal",
  objectId: "deal_4711",
} as const;

const code = {
  schemaVersion: version,
  environmentId: "environment-1",
  threadId: "thread-1",
} as const;

const presentation = { schemaVersion: version, title: "ACME Q3 renewal" } as const;

const link = {
  schemaVersion: version,
  linkId: "wjx-0123456789abcdef",
  ctox,
  code,
  presentation,
  createdAt: "2026-08-19T10:00:00.000Z",
} as const;

const artifacts = { schemaVersion: 1, commitHashes: ["abc1234"], paths: ["src/a.ts"] } as const;

describe("cross-mode link references", () => {
  it("round-trips a link through decode and encode", () => {
    const decoded = decodeLink(link);
    expect(decoded).toEqual(link);
    expect(encodeLink(decoded)).toEqual(link);
  });

  it("round-trips the optional Code-side run and artifact references", () => {
    const withRun = {
      ...link,
      code: { ...code, runTurnId: "turn-1", artifacts },
      presentation: { ...presentation, subtitle: "Stage: negotiation" },
      expiresAt: "2026-09-19T10:00:00.000Z",
    };
    expect(encodeLink(decodeLink(withRun))).toEqual(withRun);
  });

  it("keeps both authorities explicit and required", () => {
    expect(() => decodeCtox({ ...ctox, instanceId: undefined })).toThrow();
    expect(() => decodeCode({ ...code, environmentId: undefined })).toThrow();
    expect(() => decodeCode({ ...code, threadId: undefined })).toThrow();
  });

  it("bounds the Business OS object reference to CTOX's own id charset", () => {
    // CTOX validates every id it stores as [A-Za-z0-9_-]; a kind or id this
    // contract accepts must therefore be one CTOX can store.
    expect(() => decodeCtox({ ...ctox, objectKind: "deal.v2" })).toThrow();
    expect(() => decodeCtox({ ...ctox, objectId: "deal:4711" })).toThrow();
    expect(() => decodeCtox({ ...ctox, objectId: "x".repeat(129) })).toThrow();
    expect(() => decodeCtox({ ...ctox, moduleId: "crm/deals" })).toThrow();
  });

  it("refuses a control character anywhere in a reference", () => {
    expect(() => decodeCtox({ ...ctox, objectId: `deal${control}4711` })).toThrow();
    expect(() => decodePresentation({ ...presentation, title: `ACME${control}` })).toThrow();
  });
});

describe("cross-mode redaction", () => {
  /**
   * The structural half of invariant 1: presentation metadata is a CLOSED struct
   * of two short text fields. A caller that attaches a record payload finds it
   * dropped by the decode rather than carried across the authority boundary.
   */
  it("drops any field a record payload could ride in", () => {
    const smuggled = {
      ...presentation,
      record: { amount: 120_000, owner: "m.welsch@example.com" },
      data: '{"ssn":"000-00-0000"}',
      fields: ["a", "b"],
      body: "raw row",
      json: "{}",
    };
    const decoded = decodePresentation(smuggled);
    expect(decoded).toEqual(presentation);
    expect(Object.keys(decoded).sort()).toEqual(["schemaVersion", "title"]);
  });

  it("keeps the whole link free of any field that is not a reference or a label", () => {
    const decoded = decodeLink({
      ...link,
      record: { stage: "negotiation" },
      credentials: { token: "secret" },
      launch: { argv: ["ctox", "run"] },
    });
    expect(Object.keys(decoded).sort()).toEqual([
      "code",
      "createdAt",
      "ctox",
      "linkId",
      "presentation",
      "schemaVersion",
    ]);
  });

  it("caps the two presentation strings far below a serialized record", () => {
    expect(() => decodePresentation({ ...presentation, title: "x".repeat(201) })).toThrow();
    expect(() => decodePresentation({ ...presentation, subtitle: "x".repeat(281) })).toThrow();
  });

  it("carries evidence as a bounded summary plus references, never file contents", () => {
    const evidence = decodeEvidence({
      schemaVersion: version,
      summary: "Renewal terms implemented and tested.",
      artifacts,
      contents: "the entire diff",
      files: [{ path: "src/a.ts", text: "…" }],
    });
    expect(Object.keys(evidence).sort()).toEqual(["artifacts", "schemaVersion", "summary"]);
    expect(evidence.artifacts).toEqual(artifacts);
  });

  it("keeps the activity payload to ids, the operation, and the redacted title", () => {
    const activity = decodeActivity({
      schemaVersion: version,
      linkId: link.linkId,
      direction: "to-business-os",
      ctox,
      code,
      title: presentation.title,
      operation: "submit-result",
      approval: "not-required",
      createdAt: link.createdAt,
      summary: "the whole evidence summary",
      brief: "the whole scoped context",
    });
    expect(Object.keys(activity).sort()).toEqual([
      "approval",
      "code",
      "createdAt",
      "ctox",
      "direction",
      "linkId",
      "operation",
      "schemaVersion",
      "title",
    ]);
  });
});

describe("cross-mode operation inputs", () => {
  /**
   * Invariant 3, expressed in the type: a renderer cannot name the Code
   * authority, so it cannot invent one. The server fills it in.
   */
  it("gives the Open-in-Code input no way to name a Code authority", () => {
    const input = decodeOpenInput({
      ctox,
      presentation,
      hostThreadId: "thread-host",
      context: { schemaVersion: version, brief: "Implement the renewal discount rule." },
      environmentId: "environment-attacker",
    });
    expect("environmentId" in input).toBe(false);
    expect(Object.keys(input).sort()).toEqual(["context", "ctox", "hostThreadId", "presentation"]);
  });

  it("requires an explicit scoped context on every delegation", () => {
    expect(() => decodeOpenInput({ ctox, presentation, hostThreadId: "thread-host" })).toThrow();
    expect(() =>
      decodeOpenInput({
        ctox,
        presentation,
        hostThreadId: "thread-host",
        context: {
          schemaVersion: version,
          brief: "x".repeat(WORKJET_CROSS_MODE_CONTEXT_MAX_BYTES + 1),
        },
      }),
    ).toThrow();
  });

  it("reports which of create-or-select happened rather than letting the caller choose", () => {
    expect(decodeOpenResult({ schemaVersion: version, selection: "created", link }).selection).toBe(
      "created",
    );
    expect(
      decodeOpenResult({ schemaVersion: version, selection: "selected", link }).selection,
    ).toBe("selected");
    expect(() => decodeOpenResult({ schemaVersion: version, selection: "forked", link })).toThrow();
  });

  /**
   * The reverse direction names ONLY the link. There is no field in which a
   * caller could redirect a submission at a different Business OS object.
   */
  it("takes the counterpart authority from the link, never from the request", () => {
    const input = decodeSubmitInput({
      linkId: link.linkId,
      threadId: code.threadId,
      operation: "submit-result",
      evidence: { schemaVersion: version, summary: "Done.", artifacts },
      outcome: "completed",
      ctox: { ...ctox, objectId: "deal_9999" },
      instanceId: "paired:manual_pairing:attacker",
    });
    expect("ctox" in input).toBe(false);
    expect("instanceId" in input).toBe(false);
    expect(Object.keys(input).sort()).toEqual([
      "evidence",
      "linkId",
      "operation",
      "outcome",
      "threadId",
    ]);
  });

  it("covers exactly the plan's three reverse operations", () => {
    for (const operation of ["submit-result", "request-review", "follow-up"] as const) {
      const input = decodeSubmitInput({
        linkId: link.linkId,
        threadId: code.threadId,
        operation,
        evidence: { schemaVersion: version, summary: "Done.", artifacts },
      });
      expect(input.operation).toBe(operation);
    }
    expect(() =>
      decodeSubmitInput({
        linkId: link.linkId,
        threadId: code.threadId,
        operation: "close-deal",
        evidence: { schemaVersion: version, summary: "Done.", artifacts },
      }),
    ).toThrow();
  });

  it("reuses the existing approval-state vocabulary on the submit result", () => {
    const result = decodeSubmitResult({
      schemaVersion: version,
      linkId: link.linkId,
      operation: "request-review",
      status: "awaiting-approval",
      approval: "pending",
      submittedAt: link.createdAt,
    });
    expect(result.approval).toBe("pending");
    expect(() =>
      decodeSubmitResult({
        schemaVersion: version,
        linkId: link.linkId,
        operation: "request-review",
        status: "delivered",
        approval: "pending",
        submittedAt: link.createdAt,
      }),
    ).toThrow();
  });

  it("bounds the link listing", () => {
    expect(decodeListInput({})).toEqual({});
    expect(decodeListInput({ limit: WORKJET_CROSS_MODE_LINK_LIST_MAX }).limit).toBe(
      WORKJET_CROSS_MODE_LINK_LIST_MAX,
    );
    expect(() => decodeListInput({ limit: WORKJET_CROSS_MODE_LINK_LIST_MAX + 1 })).toThrow();
    expect(() => decodeListInput({ limit: 0 })).toThrow();
  });
});

describe("cross-mode failures and activity kinds", () => {
  it("keeps every refusal a bounded constant with a message", () => {
    for (const reason of [
      "unverified-authority",
      "unauthorized",
      "unknown-link",
      "link-expired",
      "approval-required",
      "ctox-command-unavailable",
      "ctox-command-rejected",
      "cross-mode-unavailable",
    ] as const) {
      const error = new WorkjetCrossModeError({ reason });
      expect(error.reason).toBe(reason);
      expect(error.message.length).toBeGreaterThan(0);
      // A refusal must not leak a path, an origin, or a token fragment.
      expect(error.message).not.toMatch(/https?:|127\.0\.0\.1|\//);
    }
  });

  it("declares the two cross-mode activity kinds under the workjet namespace", () => {
    expect(WORKJET_CROSS_MODE_ACTIVITY_KINDS).toEqual([
      "workjet.crossmode.linked",
      "workjet.crossmode.returned",
    ]);
    for (const kind of WORKJET_CROSS_MODE_ACTIVITY_KINDS) {
      expect(kind.startsWith("workjet.crossmode.")).toBe(true);
    }
  });
});
