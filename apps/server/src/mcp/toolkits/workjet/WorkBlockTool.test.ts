import { expect, it } from "@effect/vitest";

import { resolveWorkBlockStartMillis } from "./WorkBlockTool.ts";

it("keeps one continuous 5.5-hour topic as one block", () => {
  const startedAt = Date.parse("2026-09-01T08:00:00.000Z");
  const endedAt = Date.parse("2026-09-01T13:30:00.000Z");
  expect(resolveWorkBlockStartMillis(startedAt, endedAt, [])).toBe(startedAt);
  expect(endedAt - resolveWorkBlockStartMillis(startedAt, endedAt, [])).toBe(5.5 * 60 * 60_000);
});

it("starts the next block at the previous recorded block boundary", () => {
  const issuedAt = Date.parse("2026-09-01T08:00:00.000Z");
  const priorEnd = "2026-09-01T13:30:00.000Z";
  const endedAt = Date.parse("2026-09-01T14:15:00.000Z");
  expect(resolveWorkBlockStartMillis(issuedAt, endedAt, [{ endedAt: priorEnd }])).toBe(
    Date.parse(priorEnd),
  );
});
