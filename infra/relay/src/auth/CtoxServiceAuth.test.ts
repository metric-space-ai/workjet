import { describe, expect, it } from "@effect/vitest";

import { constantTimeServiceTokenMatches } from "./CtoxServiceAuth.ts";

describe("ctox service authentication", () => {
  it("accepts only the exact bearer token", () => {
    const expected = "a".repeat(43);
    expect(constantTimeServiceTokenMatches({ authorization: `Bearer ${expected}`, expected })).toBe(
      true,
    );
    expect(
      constantTimeServiceTokenMatches({ authorization: `Bearer ${"b".repeat(43)}`, expected }),
    ).toBe(false);
    expect(constantTimeServiceTokenMatches({ authorization: undefined, expected })).toBe(false);
    expect(constantTimeServiceTokenMatches({ authorization: `Basic ${expected}`, expected })).toBe(
      false,
    );
    expect(
      constantTimeServiceTokenMatches({ authorization: "Bearer short", expected: "short" }),
    ).toBe(false);
  });
});
