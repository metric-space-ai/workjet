import { describe, expect, it } from "vite-plus/test";

import { visibleRequests, type SessionUiRequest } from "./SessionRequestCards";

const base: SessionUiRequest = {
  id: "a",
  kind: "credential",
  status: "open",
  toolkit: "slack",
  fields: [],
  created_at: 1000,
};

describe("visibleRequests", () => {
  it("shows open requests for this session and unscoped ones, hides other sessions", () => {
    const all = [
      { ...base, id: "mine", session: "t1" },
      { ...base, id: "any" },
      { ...base, id: "other", session: "t2" },
    ];
    expect(visibleRequests(all, "t1", 1100).map((r) => r.id)).toEqual(["mine", "any"]);
  });
  it("keeps resolved cards briefly, then drops them", () => {
    const done = { ...base, status: "done" as const, resolved_at: 1000 };
    expect(visibleRequests([done], null, 1100)).toHaveLength(1);
    expect(visibleRequests([done], null, 1000 + 601)).toHaveLength(0);
  });
});
