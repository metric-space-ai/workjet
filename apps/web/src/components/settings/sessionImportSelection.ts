import {
  WORKJET_SESSION_IMPORT_MAX_CANDIDATES,
  type WorkjetSessionImportCandidate,
  type WorkjetSessionImportInspectInput,
  type WorkjetSessionImportInspection,
  type WorkjetSessionImportSource,
} from "@workjet/contracts";

export async function selectAllSessionImportCandidates(input: {
  readonly query: string;
  readonly source: WorkjetSessionImportSource | "all";
  readonly isActive: () => boolean;
  readonly inspect: (
    input: WorkjetSessionImportInspectInput,
  ) => Promise<WorkjetSessionImportInspection>;
  readonly onCandidates: (
    candidates: readonly WorkjetSessionImportCandidate[],
    count: number,
  ) => void;
}): Promise<void> {
  let offset = 0;
  const seen = new Set<string>();
  while (input.isActive()) {
    const page = await input.inspect({
      limit: WORKJET_SESSION_IMPORT_MAX_CANDIDATES,
      offset,
      query: input.query,
      ...(input.source === "all" ? {} : { source: input.source }),
    });
    if (!input.isActive()) return;
    if (page.discoveryLimitReached)
      throw new Error(
        "The source scan is incomplete. Refresh or update the connected server before selecting all.",
      );
    const nextOffset = page.nextOffset;
    if (nextOffset == null && page.truncated)
      throw new Error(
        "The connected server cannot continue this selection. Update it and try again.",
      );
    if (nextOffset != null && (!Number.isSafeInteger(nextOffset) || nextOffset <= offset))
      throw new Error("The conversation page did not advance. Refresh and try again.");
    const candidates = page.candidates.filter((candidate) => {
      if (seen.has(candidate.candidateId)) return false;
      seen.add(candidate.candidateId);
      return true;
    });
    input.onCandidates(candidates, seen.size);
    if (nextOffset == null) return;
    offset = nextOffset;
  }
}
