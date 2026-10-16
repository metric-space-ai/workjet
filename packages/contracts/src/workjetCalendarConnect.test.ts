import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { CtoxWorkjetProjectControlRequest, CtoxWorkjetProjectControlResponse } from "./ctox.ts";

const strict = { onExcessProperty: "error" } as const;
const request = Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest, strict);
const response = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, strict);
const start = "project.calendar.account.connect.start";
const complete = "project.calendar.account.connect.complete";

describe("calendar connect wire shape (ctox #875)", () => {
  it("carries exactly the native start and complete fields", () => {
    expect(request({ action: start, commandId: "c1", provider: "google" })).toBeTruthy();
    expect(
      request({
        action: complete,
        commandId: "c2",
        attemptId: "a1",
        callbackUrl: "https://acme.ctox.dev/cb?state=s&code=c",
      }),
    ).toBeTruthy();
    expect(() => request({ action: start, commandId: "c1", provider: "microsoft" })).toThrow();
    expect(() =>
      request({ action: start, commandId: "c1", provider: "google", actor: "other" }),
    ).toThrow();
  });

  it("accepts receipts and typed error codes, never tokens or free text", () => {
    expect(
      response({
        action: start,
        commandId: "c1",
        attemptId: "a1",
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s",
        redirectUri: "https://acme.ctox.dev/cb",
        scopes: ["openid", "email"],
        expiresAtMs: 1,
      }),
    ).toBeTruthy();
    const account = {
      id: "a@example.test",
      label: "A",
      provider: "google",
      calendar_id: "account:x",
      supported: true,
    };
    expect(response({ action: complete, commandId: "c2", account })).toBeTruthy();
    expect(() =>
      response({ action: complete, commandId: "c2", account: { ...account, token: "t" } }),
    ).toThrow();
    expect(response({ action: complete, commandId: "c2", error: "account_exists" })).toBeTruthy();
    expect(() => response({ action: start, commandId: "c1", error: "boom" })).toThrow();
  });
});
