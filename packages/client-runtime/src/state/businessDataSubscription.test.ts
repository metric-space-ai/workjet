import { describe, expect, it } from "vite-plus/test";
import {
  CTOX_BUSINESS_DATA_MAX_SNAPSHOT_BYTES,
  type NativeBusinessDataBinding,
  type NativeBusinessDataEventPayload,
  type NativeBusinessDataRecord,
} from "@workjet/contracts/ctoxBusinessData";
import { BusinessDataSubscription } from "./businessDataSubscription.ts";

const binding = { targetId: "target", instanceId: "instance", userId: "user" };
const session = { handle: "native-session", generation: 1 };
const query = {
  collection: "workjet_project_chats",
  scope: { type: "project", projectId: "project" },
  query: { selector: { project_id: "project" } },
  pageSize: 200,
} as const;
const row = (id = "chat", document: unknown = { title: "Plan" }): NativeBusinessDataRecord => ({
  documentId: id,
  document,
});

function inputs(
  overrides: {
    binding?: NativeBusinessDataBinding;
    generation?: number;
    subscriptionId?: string;
    resumeCursor?: string;
    projectId?: string;
  } = {},
) {
  const current = { ...session, generation: overrides.generation ?? 1 };
  const scopedQuery = overrides.projectId
    ? { ...query, scope: { type: "project" as const, projectId: overrides.projectId } }
    : query;
  return [
    { type: "ready", session: current, binding: overrides.binding ?? binding },
    {
      version: 1,
      requestId: "watch",
      operation: {
        type: "watch",
        session: current,
        query: scopedQuery,
        ...(overrides.resumeCursor === undefined ? {} : { resumeCursor: overrides.resumeCursor }),
      },
    },
    {
      version: 1,
      requestId: "watch",
      result: {
        type: "subscribed",
        session: current,
        subscriptionId: overrides.subscriptionId ?? "sub",
      },
    },
  ] as const;
}
function start() {
  return BusinessDataSubscription.open(...inputs());
}
function event(
  sequence: number,
  payload: NativeBusinessDataEventPayload,
  generation = 1,
  subscriptionId = "sub",
) {
  return { version: 1, session: { ...session, generation }, subscriptionId, sequence, payload };
}
function complete(projection: BusinessDataSubscription, records = [row()], first = 1) {
  projection.apply(event(first, { type: "snapshotStart", snapshotId: "snapshot" }));
  projection.apply(event(first + 1, { type: "snapshotPage", snapshotId: "snapshot", records }));
  projection.apply(
    event(first + 2, { type: "snapshotEnd", snapshotId: "snapshot", cursor: "snapshot-cursor" }),
  );
  projection.apply(event(first + 3, { type: "caughtUp", cursor: "live-cursor" }));
}

describe("native BusinessData subscription projection", () => {
  it("withholds initial pages and snapshotEnd until caughtUp", () => {
    const projection = start();
    projection.apply(event(1, { type: "snapshotStart", snapshotId: "snapshot" }));
    projection.apply(event(2, { type: "snapshotPage", snapshotId: "snapshot", records: [row()] }));
    expect(projection.read()).toMatchObject({ phase: "snapshot", records: [], cursor: null });
    projection.apply(
      event(3, { type: "snapshotEnd", snapshotId: "snapshot", cursor: "snapshot-cursor" }),
    );
    expect(projection.read()).toMatchObject({ phase: "catchingUp", records: [], cursor: null });
    projection.apply(event(4, { type: "caughtUp", cursor: "live-cursor" }));
    expect(projection.read()).toMatchObject({
      phase: "live",
      records: [row()],
      cursor: "live-cursor",
    });
  });

  it("accepts an empty completed snapshot", () => {
    const projection = start();
    projection.apply(event(1, { type: "snapshotStart", snapshotId: "empty" }));
    projection.apply(
      event(2, { type: "snapshotEnd", snapshotId: "empty", cursor: "empty-cursor" }),
    );
    projection.apply(event(3, { type: "caughtUp", cursor: "empty-cursor" }));
    expect(projection.read()).toMatchObject({ phase: "live", records: [] });
  });

  it("applies live changes and keeps removals out of later resume baselines", () => {
    const projection = start();
    complete(projection);
    expect(
      projection.apply(
        event(5, {
          type: "upsert",
          record: row("second"),
          cursor: "c5",
          recovery: false,
        }),
      ).kind,
    ).toBe("liveChange");
    expect(
      projection.apply(
        event(6, {
          type: "remove",
          documentId: "chat",
          cursor: "c6",
          recovery: false,
        }),
      ).kind,
    ).toBe("liveChange");
    expect(projection.read()).toMatchObject({ records: [row("second")], cursor: "c6" });
  });

  it("ignores a retired session or another subscription without changing current sequence", () => {
    const projection = start();
    complete(projection);
    for (const [generation, subscriptionId] of [
      [2, "sub"],
      [1, "old-sub"],
    ] as const) {
      expect(
        projection.apply(
          event(900, { type: "revoked", message: "old" }, generation, subscriptionId),
        ),
      ).toEqual({ kind: "ignored" });
    }
    expect(projection.read()).toMatchObject({ phase: "live", sequence: 4, records: [row()] });
  });

  it("rejects duplicate and missing sequence positions and cannot resurrect afterwards", () => {
    for (const sequence of [4, 6, 5.5, Number.MAX_SAFE_INTEGER + 1]) {
      const projection = start();
      complete(projection);
      projection.apply(
        event(sequence, { type: "remove", documentId: "chat", cursor: "bad", recovery: false }),
      );
      expect(projection.read()).toMatchObject({ phase: "error", records: [], cursor: null });
      expect(projection.apply(event(5, { type: "caughtUp", cursor: "late" })).kind).toBe("ignored");
    }
  });

  it("reset clears visibility and cursor but keeps sequence continuity on the same subscription", () => {
    const projection = start();
    complete(projection);
    projection.apply(event(5, { type: "reset", code: "resetRequired" }));
    expect(projection.read()).toMatchObject({
      phase: "awaitingSnapshot",
      records: [],
      cursor: null,
      sequence: 5,
    });
    complete(projection, [row("replacement")], 6);
    expect(projection.read()).toMatchObject({
      phase: "live",
      records: [row("replacement")],
      sequence: 9,
    });
  });

  it("cannot resume a reset, incomplete, revoked or closed projection", () => {
    for (const action of ["reset", "incomplete", "revoked", "closed"]) {
      const projection = start();
      if (action !== "incomplete") complete(projection);
      if (action === "reset") projection.apply(event(5, { type: "reset", code: "resetRequired" }));
      if (action === "revoked")
        projection.apply(event(5, { type: "revoked", message: "private reason" }));
      if (action === "closed") projection.close();
      expect(() =>
        BusinessDataSubscription.open(...inputs({ resumeCursor: "live-cursor" }), projection),
      ).toThrow("Invalid BusinessData subscription binding or resume checkpoint");
    }
  });

  it("resumes only matching native identity and query, hides recovery and emits no live hints for it", () => {
    const previous = start();
    complete(previous);
    previous.disconnect();
    expect(previous.read()).toMatchObject({ phase: "disconnected", records: [], cursor: null });
    expect(previous.apply(event(5, { type: "revoked", message: "old channel" })).kind).toBe(
      "ignored",
    );
    const next = BusinessDataSubscription.open(
      ...inputs({
        generation: 2,
        subscriptionId: "new-sub",
        resumeCursor: "live-cursor",
      }),
      previous,
    );
    expect(
      next.apply(
        event(
          1,
          { type: "upsert", record: row("recovered"), recovery: true, cursor: "r1" },
          2,
          "new-sub",
        ),
      ).kind,
    ).toBe("changed");
    next.apply(
      event(2, { type: "remove", documentId: "chat", recovery: true, cursor: "r2" }, 2, "new-sub"),
    );
    expect(next.read()).toMatchObject({ phase: "recovering", records: [], cursor: null });
    next.apply(event(3, { type: "caughtUp", cursor: "r2" }, 2, "new-sub"));
    expect(next.read()).toMatchObject({ phase: "live", records: [row("recovered")] });
    expect(
      next.apply(
        event(
          4,
          {
            type: "upsert",
            record: row("live"),
            recovery: false,
            cursor: "l1",
          },
          2,
          "new-sub",
        ),
      ).kind,
    ).toBe("liveChange");
  });

  it("cannot reuse a baseline across user, instance, target, project or cursor changes", () => {
    const previous = start();
    complete(previous);
    const wrongInputs = [
      { binding: { ...binding, userId: "other" } },
      { binding: { ...binding, instanceId: "other" } },
      { binding: { ...binding, targetId: "other" } },
      { projectId: "other" },
      { resumeCursor: "wrong" },
    ];
    for (const changed of wrongInputs) {
      expect(() =>
        BusinessDataSubscription.open(
          ...inputs({ resumeCursor: "live-cursor", ...changed }),
          previous,
        ),
      ).toThrow("Invalid BusinessData subscription binding or resume checkpoint");
    }
  });

  it("rejects crossed watch acknowledgements, invalid generations and caller-selected actors", () => {
    for (const generation of [0, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => BusinessDataSubscription.open(...inputs({ generation }))).toThrow();
    }
    const previous = start();
    complete(previous);
    expect(() =>
      BusinessDataSubscription.open(...inputs({ resumeCursor: "live-cursor" }), previous),
    ).toThrow();
    const [ready, request, response] = inputs();
    for (const invalid of [
      { ...response, requestId: "another-request" },
      { ...response, result: { ...response.result, session: { ...session, generation: 2 } } },
    ])
      expect(() => BusinessDataSubscription.open(ready, request, invalid)).toThrow();
    expect(() =>
      BusinessDataSubscription.open(
        { ...ready, session: { ...session, generation: Number.MAX_SAFE_INTEGER + 1 } },
        request,
        response,
      ),
    ).toThrow();
    expect(() =>
      BusinessDataSubscription.open(
        ready,
        { ...request, operation: { ...request.operation, actor: "other" } },
        response,
      ),
    ).toThrow();
  });

  it("rejects premature live changes, mismatched snapshots and duplicate initial document IDs", () => {
    const bad: NativeBusinessDataEventPayload[] = [
      { type: "upsert", record: row(), recovery: false, cursor: "early" },
      { type: "caughtUp", cursor: "early" },
      { type: "snapshotPage", snapshotId: "different", records: [row()] },
      { type: "snapshotPage", snapshotId: "snapshot", records: [row(), row()] },
    ];
    for (const payload of bad) {
      const projection = start();
      projection.apply(event(1, { type: "snapshotStart", snapshotId: "snapshot" }));
      projection.apply(event(2, payload));
      expect(projection.read()).toMatchObject({ phase: "error", records: [] });
    }
  });

  it("enforces page and retained-byte budgets including UTF-8 bytes", () => {
    for (const records of [
      Array.from({ length: 201 }, (_, i) => row(String(i))),
      [row("huge", { body: "é".repeat(CTOX_BUSINESS_DATA_MAX_SNAPSHOT_BYTES / 2) })],
    ]) {
      const projection = start();
      projection.apply(event(1, { type: "snapshotStart", snapshotId: "snapshot" }));
      projection.apply(event(2, { type: "snapshotPage", snapshotId: "snapshot", records }));
      expect(projection.read()).toMatchObject({ phase: "error", records: [], cursor: null });
    }
  });

  it("rejects recovery events after caughtUp and terminal errors cannot revive visibility", () => {
    for (const payload of [
      { type: "upsert", record: row("late"), recovery: true, cursor: "late" },
      { type: "revoked", message: "private-reason" },
      { type: "error", code: "disconnected", message: "private-reason", retryable: true },
    ] satisfies NativeBusinessDataEventPayload[]) {
      const projection = start();
      complete(projection);
      projection.apply(event(5, payload));
      expect(projection.read().records).toEqual([]);
      expect(JSON.stringify(projection.read())).not.toContain("private-reason");
      expect(projection.apply(event(6, { type: "caughtUp", cursor: "late" })).kind).toBe("ignored");
    }
  });

  it("delivers command outcomes without changing them or consuming another event position", () => {
    const projection = start();
    const state = { commandId: "command", status: "unknown" as const };
    expect(projection.apply(event(1, { type: "command", state }))).toEqual({
      kind: "command",
      state,
    });
    complete(projection, [row()], 2);
    expect(projection.read()).toMatchObject({ phase: "live", sequence: 5 });
  });

  it("preserves baseline data against mutation of input and returned document objects", () => {
    const projection = start();
    const input = row("__proto__", { title: "Original" });
    complete(projection, [input]);
    (input.document as { title: string }).title = "Changed input";
    (projection.read().records[0]!.document as { title: string }).title = "Changed output";
    expect(projection.read().records).toEqual([row("__proto__", { title: "Original" })]);
    projection.close();
    expect(projection.read()).toMatchObject({ phase: "closed", records: [], cursor: null });
  });
});
