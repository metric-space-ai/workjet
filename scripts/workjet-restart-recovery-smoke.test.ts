// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, expect, it } from "vite-plus/test";

import { interpretRestartRecovery } from "./workjet-restart-recovery-smoke.ts";

const booted = { migrationsRan: true, databaseExists: true, stderr: "" };

describe("restart recovery verdict", () => {
  it("passes only when a row written before the restart is there after it", () => {
    expect(
      interpretRestartRecovery({
        first: booted,
        second: { migrationsRan: false, databaseExists: true, stderr: "" },
        rowSurvived: true,
        usedDisposableHome: true,
      }).verdict,
    ).toBe("pass");
  });

  it("treats a second boot that ran NO migrations as normal, not broken", () => {
    // An already-migrated database legitimately has nothing to do. Conflating
    // that with a failure would make this smoke red on the ordinary case,
    // which is the fastest way to get a gate ignored.
    const result = interpretRestartRecovery({
      first: booted,
      second: { migrationsRan: false, databaseExists: true, stderr: "" },
      rowSurvived: true,
      usedDisposableHome: true,
    });
    expect(result.verdict).toBe("pass");
  });

  it("fails when the row is gone, and says what that means", () => {
    // The whole point. Durable state that does not survive a restart is not
    // durable, however green every in-memory test is.
    const result = interpretRestartRecovery({
      first: booted,
      second: booted,
      rowSurvived: false,
      usedDisposableHome: true,
    });
    expect(result.verdict).toBe("fail");
    expect(result.detail).toContain("durable state is not durable");
  });

  it("fails when the database vanished across the restart", () => {
    expect(
      interpretRestartRecovery({
        first: booted,
        second: { migrationsRan: false, databaseExists: false, stderr: "" },
        rowSurvived: false,
        usedDisposableHome: true,
      }).detail,
    ).toContain("vanished");
  });

  it("fails when the first boot never initialised, and quotes why", () => {
    const result = interpretRestartRecovery({
      first: { migrationsRan: false, databaseExists: false, stderr: "port already in use" },
      second: booted,
      rowSurvived: false,
      usedDisposableHome: true,
    });
    expect(result.verdict).toBe("fail");
    expect(result.detail).toContain("port already in use");
  });

  it("refuses to pass if it did not use a disposable state directory", () => {
    // A smoke that quietly ran against the developer's real T3CODE_HOME would
    // be destructive AND a false pass, so this is checked before anything
    // else and cannot be overridden by a good-looking result.
    const result = interpretRestartRecovery({
      first: booted,
      second: booted,
      rowSurvived: true,
      usedDisposableHome: false,
    });
    expect(result.verdict).toBe("fail");
    expect(result.detail).toContain("disposable");
  });
});
