// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Compares what an operator DECLARED against what the host actually found.
 *
 * The declared `available` switch is intent; the probe is fact. The useful
 * thing to show is neither on its own but the DISAGREEMENT between them,
 * because that is the state nobody can see today and the one that produces a
 * delegation failing at run time:
 *
 *  - declared available, probed missing → the profile will be dispatched to a
 *    harness that is not there. This is the dangerous direction and the reason
 *    the whole item exists.
 *  - declared unavailable, probed present → harmless, but worth showing:
 *    capacity the operator has switched off without meaning to.
 *
 * Pure, so the comparison is testable without rendering anything.
 */
import type {
  WorkjetHarness,
  WorkjetHarnessAvailability,
  WorkjetHarnessAvailabilitySnapshot,
} from "@t3tools/contracts";

export type HarnessAvailabilityView =
  /** No probe has run, or it did not cover this harness. Say so; do not guess. */
  | { readonly kind: "unknown" }
  | { readonly kind: "agrees"; readonly available: boolean; readonly version?: string }
  | {
      readonly kind: "declared-but-missing";
      readonly reason: WorkjetHarnessAvailabilityReasonText;
    }
  | { readonly kind: "present-but-switched-off"; readonly version?: string };

export type WorkjetHarnessAvailabilityReasonText = string;

/**
 * Operator-facing text for a probe reason.
 *
 * Each says what to DO, not what the code observed. "probe-failed" and
 * "timeout" deliberately read differently: one means it answered wrongly, the
 * other that it never answered, and the fix is not the same.
 */
export function harnessReasonText(
  reason: Extract<WorkjetHarnessAvailability, { availability: "unavailable" }>["reason"],
): string {
  switch (reason) {
    case "executable-not-found":
      return "Not installed, or not on this host's PATH.";
    case "not-executable":
      return "Found, but this server may not execute it. Check its permissions.";
    case "timeout":
      return "Did not answer in time. It may be hanging or waiting for input.";
    case "probe-failed":
      return "Ran, but reported a failure.";
    case "unsupported-host":
      return "Cannot run on this operating system or architecture.";
  }
}

export function resolveHarnessAvailabilityView(input: {
  readonly declaredAvailable: boolean;
  readonly harness: WorkjetHarness;
  readonly snapshot: WorkjetHarnessAvailabilitySnapshot | null;
}): HarnessAvailabilityView {
  if (input.snapshot === null) return { kind: "unknown" };
  const probed = input.snapshot.harnesses.find((entry) => entry.harness === input.harness);
  // A harness the probe did not cover is UNKNOWN, never "fine". The probe only
  // covers harnesses named by a worker profile, so an unprofiled one is simply
  // unmeasured, and saying otherwise would be the same unverified optimism the
  // probe replaces.
  if (probed === undefined) return { kind: "unknown" };

  if (probed.availability === "available") {
    return input.declaredAvailable
      ? {
          kind: "agrees",
          available: true,
          ...(probed.version === undefined ? {} : { version: probed.version }),
        }
      : {
          kind: "present-but-switched-off",
          ...(probed.version === undefined ? {} : { version: probed.version }),
        };
  }
  return input.declaredAvailable
    ? { kind: "declared-but-missing", reason: harnessReasonText(probed.reason) }
    : { kind: "agrees", available: false };
}
