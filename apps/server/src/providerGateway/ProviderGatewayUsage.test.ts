import { describe, expect, it } from "vite-plus/test";
import { readGatewayUsage, usageWindow } from "./ProviderGatewayUsage.ts";

const receipt = (at: string, changes: Record<string, unknown> = {}) => ({
  completedAtMs: Date.parse(at), provider: "codex", model: "gpt-6", modelSource: "response",
  error: false, inputTokens: 12, outputTokens: 4, cacheReadTokens: null, cacheWriteTokens: null,
  ...changes,
});
const reader = (receipts: Array<ReturnType<typeof receipt>>) => {
  const journals = new Map<number, string>();
  for (const entry of receipts) {
    const day = Math.floor(entry.completedAtMs / 86_400_000);
    journals.set(day, `${journals.get(day) ?? ""}${JSON.stringify(entry)}\n`);
  }
  return async (day: number) => journals.get(day) ?? null;
};
describe("gateway inference receipts", () => {
  it("groups by local day across Berlin DST and combines models across providers", async () => {
    const result = await readGatewayUsage({ days: 7, timeZone: "Europe/Berlin" }, Date.parse("2026-03-30T12:00:00Z"), reader([
      receipt("2026-03-28T22:59:59Z"),
      receipt("2026-03-28T23:00:00Z", { provider: "openai", error: true, inputTokens: null, outputTokens: null }),
      receipt("2026-03-29T21:59:59Z"),
      receipt("2026-03-29T22:00:00Z"),
    ]));
    expect(result.daily.map((row) => [row.date, row.provider, row.requests])).toEqual([
      ["2026-03-28", "codex", 1], ["2026-03-29", "codex", 1], ["2026-03-29", "openai", 1], ["2026-03-30", "codex", 1],
    ]);
    expect(result.modelTotals).toHaveLength(1);
    expect(result.modelTotals[0]).toMatchObject({ model: "gpt-6", requests: 4, errors: 1, inputTokens: 36, inputMeasuredRequests: 3, cacheReadTokens: null, cacheReadMeasuredRequests: 0 });
  });
  it("excludes receipts outside the local calendar window and future completions", async () => {
    const result = await readGatewayUsage({ days: 7, timeZone: "Pacific/Kiritimati" }, Date.parse("2026-10-02T01:00:00Z"), reader([
      receipt("2026-09-25T09:59:59Z"), receipt("2026-09-25T10:00:00Z"), receipt("2026-10-02T02:00:00Z"),
    ]));
    expect(result.startDate).toBe("2026-09-26"); expect(result.totals.requests).toBe(1);
  });
  it("keeps reported zero separate from an unavailable counter", async () => {
    const result = await readGatewayUsage({ days: 30 }, Date.parse("2026-10-02T12:00:00Z"), reader([receipt("2026-10-02T01:00:00Z", { inputTokens: 0 })]));
    expect(result.totals.inputTokens).toBe(0); expect(result.totals.inputMeasuredRequests).toBe(1); expect(result.totals.cacheReadTokens).toBeNull();
  });
  it("defers a concurrently appended final line and rejects a malformed complete line", async () => {
    const day = Math.floor(Date.parse("2026-10-02T01:00:00Z") / 86_400_000);
    const result = await readGatewayUsage({ days: 7 }, Date.parse("2026-10-02T12:00:00Z"), async (d) => d === day ? `${JSON.stringify(receipt("2026-10-02T01:00:00Z"))}\n{"inprogress":` : null);
    expect(result.totals.requests).toBe(1);
    await expect(readGatewayUsage({ days: 7 }, Date.parse("2026-10-02T12:00:00Z"), async (d) => d === day ? "broken\n" : null)).rejects.toThrow();
  });
  it("validates timezone identifiers and reports no historical collection honestly", async () => {
    expect(() => usageWindow({ days: 7, timeZone: "Invalid/Zone" }, 0)).toThrow();
    expect(() => usageWindow({ days: 7, timeZone: "+01:00" }, 0)).toThrow();
    const result = await readGatewayUsage({ days: 7 }, Date.parse("2026-10-02T12:00:00Z"), async () => null);
    expect(result.availability).toBe("not-collected-yet"); expect(result.totals.inputTokens).toBeNull();
  });
});
