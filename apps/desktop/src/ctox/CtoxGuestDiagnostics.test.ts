import { describe, expect, it } from "vite-plus/test";
import { guestPreparationDiagnostic } from "./CtoxGuestDiagnostics";

describe("guest preparation diagnostics", () => {
  it("retains the navigation stage and numeric Electron failure", () => {
    expect(
      guestPreparationDiagnostic("navigation_commit", {
        reason: "did_fail_load",
        errorCode: -102,
      }),
    ).toEqual({ stage: "navigation_commit", reason: "did_fail_load", errorCode: -102 });
  });
  it("never includes exception messages, URLs, tokens or arbitrary strings", () => {
    const diagnostic = guestPreparationDiagnostic("session", {
      reason: "token=secret",
      message: "https://host/?token=secret",
      code: "SECRET_TOKEN",
      httpStatus: 401,
      name: "secret",
    });
    expect(diagnostic).toEqual({ stage: "session", reason: "unknown", httpStatus: 401 });
  });
});
