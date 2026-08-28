// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Applying a worker's reasoning effort — only when the provider actually
 * offers that value.
 *
 * A Workjet worker records `reasoning` from a fixed list (automatic, low,
 * medium, high, xhigh, max, ultra, ultracode, ultrathink). A provider offers
 * its own effort options, and the two lists are neither identical nor mapped
 * anywhere in this codebase.
 *
 * So this does NOT translate. It matches by value, case-insensitively, and
 * returns `null` when the provider has nothing by that name. Guessing a
 * neighbour — "max" onto "high" because both sound large — would silently run
 * the turn at an effort the operator never chose and cost real money doing it.
 * A worker whose effort this provider cannot express keeps the provider's own
 * default, which is at least a value the operator can see in the bar.
 *
 * `automatic` is deliberately also `null`: it means "do not force one", so
 * writing an explicit selection for it would be the opposite of what it says.
 */
import type { ModelCapabilities, ProviderOptionSelection } from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export function workerReasoningSelections(input: {
  readonly caps: ModelCapabilities;
  readonly reasoning: string;
}): ReadonlyArray<ProviderOptionSelection> | null {
  const wanted = input.reasoning.trim().toLowerCase();
  if (wanted === "" || wanted === "automatic") return null;

  const descriptors = getProviderOptionDescriptors({ caps: input.caps });
  const primary = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  if (primary === undefined) return null;

  const match = primary.options.find((option) => option.id.toLowerCase() === wanted);
  if (match === undefined) return null;

  const selections = buildProviderOptionSelectionsFromDescriptors(
    descriptors.map((descriptor) =>
      descriptor.id === primary.id && descriptor.type === "select"
        ? { ...descriptor, currentValue: match.id }
        : descriptor,
    ),
  );
  return selections ?? null;
}
