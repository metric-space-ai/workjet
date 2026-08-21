// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { WorkjetHarness, WorkjetHarnessAvailabilitySnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  harnessReasonText,
  resolveHarnessAvailabilityView,
} from "./workjetHarnessAvailabilityView";

const CLAUDE = "claude-code" as WorkjetHarness;
const CODEX = "codex-cli" as WorkjetHarness;

const snapshot = (
  harnesses: WorkjetHarnessAvailabilitySnapshot["harnesses"],
): WorkjetHarnessAvailabilitySnapshot => ({
  schemaVersion: 1,
  probedAt: "2026-08-20T10:00:00.000Z",
  harnesses,
});

describe("declared versus probed", () => {
  it("flags the dangerous direction: switched on, not actually there", () => {
    // This is the state the whole item exists to surface. Without it the
    // mismatch appears only when a delegation is already running.
    const view = resolveHarnessAvailabilityView({
      declaredAvailable: true,
      harness: CLAUDE,
      snapshot: snapshot([
        { harness: CLAUDE, availability: "unavailable", reason: "executable-not-found" },
      ]),
    });

    expect(view.kind).toBe("declared-but-missing");
    expect(view.kind === "declared-but-missing" ? view.reason : "").toContain("Not installed");
  });

  it("flags the harmless direction too: present but switched off", () => {
    const view = resolveHarnessAvailabilityView({
      declaredAvailable: false,
      harness: CLAUDE,
      snapshot: snapshot([
        {
          harness: CLAUDE,
          availability: "available",
          executablePath: "/bin/claude",
          version: "2.1",
        },
      ]),
    });

    expect(view.kind).toBe("present-but-switched-off");
    expect(view.kind === "present-but-switched-off" ? view.version : "").toBe("2.1");
  });

  it("says AGREES in both matching directions, not just the positive one", () => {
    const on = resolveHarnessAvailabilityView({
      declaredAvailable: true,
      harness: CLAUDE,
      snapshot: snapshot([
        { harness: CLAUDE, availability: "available", executablePath: "/bin/claude" },
      ]),
    });
    const off = resolveHarnessAvailabilityView({
      declaredAvailable: false,
      harness: CLAUDE,
      snapshot: snapshot([
        { harness: CLAUDE, availability: "unavailable", reason: "executable-not-found" },
      ]),
    });

    expect(on).toEqual({ kind: "agrees", available: true });
    expect(off).toEqual({ kind: "agrees", available: false });
  });

  it("says UNKNOWN when nothing probed it, rather than implying agreement", () => {
    // The probe only covers harnesses a worker profile names, so an unprofiled
    // one is unmeasured. Reporting it as fine would be the same unverified
    // optimism the probe replaces.
    expect(
      resolveHarnessAvailabilityView({ declaredAvailable: true, harness: CLAUDE, snapshot: null }),
    ).toEqual({ kind: "unknown" });

    expect(
      resolveHarnessAvailabilityView({
        declaredAvailable: true,
        harness: CLAUDE,
        snapshot: snapshot([
          { harness: CODEX, availability: "available", executablePath: "/bin/codex" },
        ]),
      }),
    ).toEqual({ kind: "unknown" });
  });
});

describe("reason text", () => {
  it("tells the operator what to DO, and keeps timeout apart from failure", () => {
    // One answered wrongly, the other never answered. The fixes differ, so the
    // texts must not collapse into one.
    expect(harnessReasonText("not-executable")).toContain("permissions");
    expect(harnessReasonText("timeout")).toContain("hanging");
    expect(harnessReasonText("probe-failed")).not.toContain("hanging");
    expect(harnessReasonText("executable-not-found")).toContain("PATH");
    expect(harnessReasonText("unsupported-host")).toContain("operating system");
  });
});
