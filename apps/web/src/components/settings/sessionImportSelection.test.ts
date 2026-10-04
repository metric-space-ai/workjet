import { ProviderInstanceId, type WorkjetSessionImportCandidate } from "@workjet/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { selectAllSessionImportCandidates } from "./sessionImportSelection";

const candidate = (index: number): WorkjetSessionImportCandidate => ({
  candidateId: `wjsi_${index.toString(16).padStart(32, "0")}`,
  source: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  title: `Conversation ${index}`,
  workspaceRoot: "/workspace/source",
  workspaceAvailable: true,
  createdAt: "2026-10-02T10:00:00Z",
  updatedAt: "2026-10-02T11:00:00Z",
  sourceSizeBytes: 42,
  importedThreadId: null,
});
const lastPage = (candidates: readonly WorkjetSessionImportCandidate[] = []) => ({
  sources: [],
  candidates,
  truncated: false,
  nextOffset: null,
});

describe("complete conversation selection", () => {
  it("selects more than 5000 matches across every bounded page", async () => {
    const selected: string[] = [];
    const inspect = vi.fn(async ({ offset = 0, limit = 100 }) => {
      const end = Math.min(offset + limit, 5002);
      return {
        sources: [],
        candidates: Array.from({ length: end - offset }, (_, i) => candidate(offset + i)),
        truncated: end < 5002,
        nextOffset: end < 5002 ? end : null,
      };
    });
    await selectAllSessionImportCandidates({
      query: "conversation",
      source: "all",
      isActive: () => true,
      inspect,
      onCandidates: (items) => selected.push(...items.map((item) => item.candidateId)),
    });
    expect(inspect).toHaveBeenCalledTimes(51);
    expect(inspect.mock.calls[0]?.[0]).toMatchObject({
      query: "conversation",
      limit: 100,
      offset: 0,
    });
    expect(selected).toHaveLength(5002);
    expect(new Set(selected).size).toBe(5002);
    expect(selected.at(-1)).toBe(candidate(5001).candidateId);
  });

  it("retains the harness filter and de-duplicates overlapping source pages", async () => {
    const received: string[] = [];
    await selectAllSessionImportCandidates({
      query: "feature",
      source: "codex",
      isActive: () => true,
      inspect: async (input) => {
        expect(input.source).toBe("codex");
        return input.offset === 0
          ? { ...lastPage([candidate(1)]), truncated: true, nextOffset: 1 }
          : lastPage([candidate(1), candidate(2)]);
      },
      onCandidates: (items) => received.push(...items.map((item) => item.candidateId)),
    });
    expect(received).toEqual([candidate(1).candidateId, candidate(2).candidateId]);
  });

  it("stops before another request and discards a reply after cancellation or scope change", async () => {
    let active = true;
    const onCandidates = vi.fn();
    const inspect = vi.fn(async () => {
      active = false;
      return lastPage([candidate(1)]);
    });
    await selectAllSessionImportCandidates({
      query: "",
      source: "all",
      isActive: () => active,
      inspect,
      onCandidates,
    });
    expect(onCandidates).not.toHaveBeenCalled();
    await selectAllSessionImportCandidates({
      query: "",
      source: "all",
      isActive: () => false,
      inspect,
      onCandidates,
    });
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("refuses incomplete discovery, missing continuation and non-advancing cursors", async () => {
    for (const page of [
      { ...lastPage(), discoveryLimitReached: true },
      { ...lastPage(), truncated: true },
      { ...lastPage(), truncated: true, nextOffset: 0 },
      { ...lastPage(), nextOffset: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const onCandidates = vi.fn();
      await expect(
        selectAllSessionImportCandidates({
          query: "",
          source: "all",
          isActive: () => true,
          inspect: async () => page,
          onCandidates,
        }),
      ).rejects.toThrow();
      expect(onCandidates).not.toHaveBeenCalled();
    }
  });
});
