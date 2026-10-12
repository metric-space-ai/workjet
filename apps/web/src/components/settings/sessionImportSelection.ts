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
  let discoveryVersion: string | undefined;
  const seen = new Set<string>();
  while (input.isActive()) {
    const page = await input.inspect({
      limit: WORKJET_SESSION_IMPORT_MAX_CANDIDATES,
      offset,
      query: input.query,
      ...(input.source === "all" ? {} : { source: input.source }),
    });
    if (!input.isActive()) return;
    if (!page.discoveryVersion)
      throw new Error("Server erkennt keine Änderungen. Server aktualisieren.");
    if (discoveryVersion !== undefined && page.discoveryVersion !== discoveryVersion)
      throw new Error("Unterhaltungen während der Auswahl geändert. Neu laden.");
    discoveryVersion = page.discoveryVersion;
    if (page.discoveryLimitReached)
      throw new Error("Suche unvollständig. Neu laden oder Server aktualisieren.");
    const nextOffset = page.nextOffset;
    if (nextOffset == null && page.truncated)
      throw new Error("Server kann die Auswahl nicht fortsetzen. Server aktualisieren.");
    if (nextOffset != null && (!Number.isSafeInteger(nextOffset) || nextOffset <= offset))
      throw new Error("Seite rückt nicht vor. Neu laden.");
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
