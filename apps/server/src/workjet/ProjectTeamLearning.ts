/** Mirrors the existing proxy-model-workers empirical selection policy. */
export interface TeamSelectionObservation {
  readonly selectionId: string;
  readonly candidate: string;
  readonly taskType: string;
  readonly difficulty: string;
  readonly reasoning: string;
  readonly randomized: boolean;
  /** First delivery only. Missing reviews and availability failures remain unassessed. */
  readonly firstScore: number | null;
  readonly cause: "model" | "task_spec" | "quota" | "transport" | "unknown";
}

export function compareTeamCandidates(input: {
  /** Candidate keys include actual model, harness and version; never pool versions. */
  readonly candidates: ReadonlyArray<string>;
  readonly observations: ReadonlyArray<TeamSelectionObservation>;
  readonly taskType: string;
  readonly difficulty: string;
  readonly reasoning: string;
}) {
  const candidates = [...new Set(input.candidates)].sort();
  const seen = new Set<string>();
  const grouped = new Map(candidates.map((candidate) => [candidate, [] as Array<number | null>]));
  for (const observation of input.observations) {
    if (
      !observation.randomized ||
      seen.has(observation.selectionId) ||
      observation.taskType !== input.taskType ||
      observation.difficulty !== input.difficulty ||
      observation.reasoning !== input.reasoning ||
      !grouped.has(observation.candidate)
    )
      continue;
    seen.add(observation.selectionId);
    const score = observation.firstScore;
    const assessed =
      observation.cause === "model" &&
      score !== null &&
      Number.isInteger(score) &&
      score >= 0 &&
      score <= 10;
    grouped.get(observation.candidate)!.push(assessed ? score : null);
  }
  const rows = candidates.map((candidate) => {
    const values = grouped.get(candidate)!;
    const known = values.filter((value): value is number => value !== null);
    const n = values.length;
    const sum = known.reduce((total, value) => total + value, 0);
    const missing = n - known.length;
    // 95% bounded-score intervals with alpha spending across repeated looks.
    const radius = n
      ? 10 * Math.sqrt(Math.log((2 * candidates.length * n * (n + 1)) / 0.05) / (2 * n))
      : 10;
    return {
      candidate,
      assigned: n,
      scored: known.length,
      unassessed: missing,
      mean: known.length ? sum / known.length : null,
      low: n ? Math.max(0, sum / n - radius) : 0,
      high: n ? Math.min(10, (sum + 10 * missing) / n + radius) : 10,
    };
  });
  const winner =
    rows.length > 1
      ? (rows.find((row) =>
          rows.every((other) => row.candidate === other.candidate || row.low > other.high),
        )?.candidate ?? null)
      : null;
  return { winner, rows };
}

/** The caller persists this result before dispatch and reuses it on retries. */
export function drawTeamCandidate(input: {
  readonly available: ReadonlyArray<string>;
  readonly winner: string | null;
  /** One server-generated uniform draw in [0,1). */
  readonly draw: number;
}) {
  if (!Number.isFinite(input.draw) || input.draw < 0 || input.draw >= 1) {
    throw new RangeError("Selection draw must be in [0,1).");
  }
  const available = [...new Set(input.available)].sort();
  if (!available.length) return null;
  const useWinner =
    input.winner !== null && available.includes(input.winner) && available.length > 1;
  const probabilities = available.map((candidate) => ({
    candidate,
    probability: useWinner
      ? candidate === input.winner
        ? 0.5
        : 0.5 / (available.length - 1)
      : 1 / available.length,
  }));
  let cumulative = 0;
  const selected =
    probabilities.find((entry) => {
      cumulative += entry.probability;
      return input.draw < cumulative;
    }) ?? probabilities[probabilities.length - 1]!;
  return {
    candidate: selected.candidate,
    draw: input.draw,
    probabilities,
    mode: useWinner ? "adaptive" : "uniform",
  };
}
