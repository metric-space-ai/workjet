// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The Workjet-owned Codex turn options, as one spread.
 *
 * `CodexSessionRuntime.ts` is the worst upstream conflict site in the fork —
 * 5 of 43 measured hunks, and recurring BY CONSTRUCTION (docs/
 * workjet-upstream-conflict-map.md:149). The cause is structural rather than
 * unlucky: Workjet threads its own option through the same object literals
 * upstream keeps extending with theirs (`browserToolsAvailable` and whatever
 * comes next), so both streams edit the same line ranges every cycle.
 *
 * Keeping the fork's options behind a single spread means upstream's additions
 * land in the literal and Workjet's land HERE, in a file upstream does not
 * have. The call sites stay one line each, which a merge can carry.
 *
 * Add every future Workjet turn option to this helper, never inline at a call
 * site — inlining one silently restores the conflict this file exists to end.
 */
export interface CodexWorkjetTurnOptionsInput {
  readonly compiledManagedPrompt?: string;
}

export function codexWorkjetTurnOptions(
  input: CodexWorkjetTurnOptionsInput,
): CodexWorkjetTurnOptionsInput {
  return input.compiledManagedPrompt === undefined
    ? {}
    : { compiledManagedPrompt: input.compiledManagedPrompt };
}
