import { describe, expect, it } from "vite-plus/test";

import { canSubmitCredential } from "../toolhub/ToolhubCards";
import {
  cacheable,
  openCount,
  visibleRequests,
  type SessionUiRequest,
} from "./SessionRequestCards";

const base: SessionUiRequest = {
  id: "a",
  kind: "credential",
  status: "open",
  toolkit: "slack",
  fields: [{ name: "token", secret: true }],
  created_at: 1000,
};

describe("visibleRequests", () => {
  it("pins open requests for this session and unscoped ones, hides other sessions", () => {
    const all = [
      { ...base, id: "mine", session: "t1" },
      { ...base, id: "any" },
      { ...base, id: "other", session: "t2" },
    ];
    expect(visibleRequests(all, "t1", 1100).map((r) => r.id)).toEqual(["mine", "any"]);
  });
  it("keeps open requests pinned no matter how old, oldest first", () => {
    const all = [
      { ...base, id: "new", created_at: 5000 },
      { ...base, id: "old", created_at: 10 },
    ];
    expect(visibleRequests(all, null, 999_999).map((r) => r.id)).toEqual(["old", "new"]);
    expect(openCount(all)).toBe(2);
  });
  it("shows resolved cards briefly, then drops them", () => {
    const done = { ...base, status: "done" as const, resolved_at: 1000 };
    expect(visibleRequests([done], null, 1005)).toHaveLength(1);
    expect(visibleRequests([done], null, 1000 + 60)).toHaveLength(0);
  });
});

describe("cacheable", () => {
  it("keeps only open request metadata for the restart cache", () => {
    const list = [base, { ...base, id: "b", status: "declined" as const }];
    expect(cacheable(list).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("canSubmitCredential", () => {
  const secrets = [{ name: "token", secret: true }];
  const params = [
    { key: "subdomain", required: true },
    { key: "region", required: false },
  ];
  it("needs every secret and every required param", () => {
    expect(canSubmitCredential(secrets, params, { token: "x" })).toBe(false);
    expect(canSubmitCredential(secrets, params, { token: " ", subdomain: "acme" })).toBe(false);
    expect(canSubmitCredential(secrets, params, { token: "x", subdomain: "acme" })).toBe(true);
  });
});
