// @effect-diagnostics nodeBuiltinImport:off -- Verify isolated native snapshot bytes; no model or installed pass claim.
import * as NodeCrypto from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import { createNativeSupervisorConfirmedGoalReader } from "./NativeSupervisorConfirmedGoalReader.ts";
import { goalDocument, goalPage } from "./NativeSupervisorConfirmedGoalFixture.ts";

const accepted = {
  goal: { goal_id: "fixture-goal", revision: 3 },
  status: "active",
  items: [{ id: "fixture-item", title: "Actual Owner goal", acceptance: "Actual acceptance" }],
  steps: [
    {
      id: "fixture-step",
      status: "running",
      dispatch: { emission_attempts: 2, message_key: "actual-saved-key" },
      result_excerpt: "Saved partial evidence",
    },
  ],
};
function fixture(
  document: unknown = goalDocument(),
  change?: (page: ReturnType<typeof goalPage>, index: number) => unknown,
) {
  let snapshotId: string | undefined;
  let count = 0;
  const requestPage = vi.fn(async (operationId: string, json: string) => {
    const { cursor } = JSON.parse(json) as { cursor?: string };
    if (cursor === undefined) snapshotId = operationId;
    if (!snapshotId) throw new Error("Fixture continuation has no original snapshot");
    const page = goalPage(document, snapshotId, cursor ? Number(cursor.split(":")[1]) : 0);
    return change?.(page, count++) ?? page;
  });
  const reader = createNativeSupervisorConfirmedGoalReader({
    projectId: "fixture-project",
    supervisorThreadId: "fixture-supervisor",
    requestPage,
  });
  return { reader, requestPage, id: NodeCrypto.randomUUID() };
}
it("preserves no confirmed goal without inventing work completion", async () => {
  const { reader, id } = fixture();
  expect(await reader.read(id)).toMatchObject({
    state: "verified",
    snapshot_verified: true,
    confirmed_goal: null,
  });
  reader.close();
  await expect(reader.read(NodeCrypto.randomUUID())).rejects.toThrow("closed");
});
it("returns actual goal, selected item, native dispatch and partial progress", async () => {
  const { reader, id } = fixture(goalDocument(accepted));
  const result = await reader.read(id);
  expect(result).toMatchObject({
    state: "verified",
    context_state: "available",
    confirmed_goal: {
      goal: accepted.goal,
      status: "active",
      item_count: 1,
      selected_item_index: 0,
      item: accepted.items[0],
      step: accepted.steps[0],
    },
  });
  expect(result).not.toHaveProperty("document_complete");
  expect(result).not.toHaveProperty("completed");
  expect(result).not.toHaveProperty("json_fragment");
  reader.close();
});
it("assembles a near-native-limit escaped Unicode snapshot in one read, outside model context", async () => {
  const large = {
    ...accepted,
    items: [
      { ...accepted.items[0], acceptance: '🧭é"\\\n'.repeat(80_000) },
      { id: "second", title: "Bounded selected item", acceptance: "Owner acceptance" },
    ],
    steps: [accepted.steps[0], { id: "second-step", status: "pending" }],
  };
  const document = goalDocument(large);
  expect(Buffer.byteLength(JSON.stringify(document))).toBeGreaterThan(900_000);
  expect(Buffer.byteLength(JSON.stringify(document))).toBeLessThanOrEqual(1_052_672);
  const { reader, requestPage, id } = fixture(document);
  const result = await reader.read(id, 1);
  expect(requestPage.mock.calls.length).toBeGreaterThan(32);
  expect(requestPage.mock.calls.length).toBeLessThanOrEqual(43);
  expect(new Set(requestPage.mock.calls.map(([operation]) => operation)).size).toBe(
    requestPage.mock.calls.length,
  );
  expect(requestPage.mock.calls[0]?.[0]).toBe(id);
  expect(requestPage.mock.calls[0]?.[1]).toBe("{}");
  expect(result).toMatchObject({
    snapshot_verified: true,
    context_state: "available",
    confirmed_goal: { item: large.items[1], step: large.steps[1], item_count: 2 },
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
  expect(JSON.stringify(result)).not.toContain("json_fragment");
  reader.close();
});
it("reports oversized selected context explicitly, without truncating the saved acceptance", async () => {
  const { reader, id } = fixture(
    goalDocument({
      ...accepted,
      items: [{ ...accepted.items[0], acceptance: "Owner text ".repeat(2000) }],
    }),
  );
  const result = await reader.read(id);
  expect(result).toMatchObject({
    snapshot_verified: true,
    context_state: "item_exceeds_model_budget",
    confirmed_goal: { goal: accepted.goal, status: "active" },
  });
  expect(result).not.toHaveProperty("confirmed_goal.item");
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
  reader.close();
});
it.each(["snapshot_changed", "snapshot_unavailable", "capacity_unavailable"])(
  "returns %s without retrying or retiring the original reader",
  async (state) => {
    let unavailable = true;
    const { reader, requestPage, id } = fixture(goalDocument(accepted), (page) =>
      unavailable
        ? {
            ...page,
            state,
            byte_offset: 0,
            byte_length: 0,
            json_fragment: "",
            document_complete: false,
            next_cursor: null,
          }
        : page,
    );
    expect(await reader.read(id)).toMatchObject({ state, snapshot_verified: false });
    expect(requestPage).toHaveBeenCalledTimes(1);
    unavailable = false;
    expect(await reader.read(NodeCrypto.randomUUID())).toMatchObject({ snapshot_verified: true });
    reader.close();
  },
);
it.each([
  { project_id: "foreign-project" },
  { supervisor_thread_id: "foreign-thread" },
  { snapshot_id: NodeCrypto.randomUUID() },
  { byte_offset: 1 },
  { byte_length: 1 },
  { document_sha256: "0".repeat(64) },
  { document_bytes: 1_052_673 },
  { next_cursor: "forged:0" },
  { json_fragment: "\ud800" },
  { authority: true },
])("rejects foreign or malformed native snapshot facts: %o", async (change) => {
  const { reader, requestPage, id } = fixture(goalDocument(), (page) => ({ ...page, ...change }));
  await expect(reader.read(id)).rejects.toThrow();
  expect(requestPage).toHaveBeenCalledTimes(1);
  reader.close();
});
it.each(["document_sha256", "document_bytes", "captured_at_ms", "byte_offset", "next_cursor"])(
  "rejects changed %s on a continuation without another read",
  async (field) => {
    const document = goalDocument({
      ...accepted,
      items: [{ ...accepted.items[0], acceptance: "a".repeat(80_000) }],
    });
    const { reader, requestPage, id } = fixture(document, (page, index) =>
      index === 1
        ? {
            ...page,
            [field]:
              field === "document_sha256"
                ? "1".repeat(64)
                : field === "next_cursor"
                  ? `${page.snapshot_id}:000`
                  : Number(page[field as keyof typeof page]) + 1,
          }
        : page,
    );
    await expect(reader.read(id)).rejects.toThrow();
    expect(requestPage).toHaveBeenCalledTimes(2);
    reader.close();
  },
);
it("rejects a scoped document mismatch even with valid paging and digest", async () => {
  const { reader, id } = fixture({ ...goalDocument(), project_id: "foreign-project" });
  await expect(reader.read(id)).rejects.toThrow("scope");
  reader.close();
});
