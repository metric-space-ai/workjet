import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@workjet/contracts";
import { ctoxCrewResumeIdentity } from "./CtoxCrewResumeIdentity.ts";

it("extracts only a current provider conversation identity", () => {
  expect(ctoxCrewResumeIdentity(ProviderDriverKind.make("codex"), { threadId: "codex-1" })).toBe(
    "codex-1",
  );
  for (const provider of ["grok", "cursor", "opencode"] as const) {
    expect(
      ctoxCrewResumeIdentity(ProviderDriverKind.make(provider), {
        schemaVersion: 1,
        sessionId: `${provider}-1`,
      }),
    ).toBe(`${provider}-1`);
    expect(
      ctoxCrewResumeIdentity(ProviderDriverKind.make(provider), {
        schemaVersion: 2,
        sessionId: `${provider}-1`,
      }),
    ).toBeNull();
  }
  expect(
    ctoxCrewResumeIdentity(ProviderDriverKind.make("claudeAgent"), {
      resume: "123e4567-e89b-42d3-a456-426614174000",
    }),
  ).toBe("123e4567-e89b-42d3-a456-426614174000");
  expect(
    ctoxCrewResumeIdentity(ProviderDriverKind.make("codex"), { threadId: " bad " }),
  ).toBeNull();
  expect(ctoxCrewResumeIdentity(ProviderDriverKind.make("opencode"), {})).toBeNull();
});
