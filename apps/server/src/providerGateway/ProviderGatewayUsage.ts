import {
  NonNegativeInt,
  type WorkjetGatewayUsage,
  type WorkjetGatewayUsageCounters,
  type WorkjetGatewayUsageInput,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";

const Receipt = Schema.Struct({
  completedAtMs: NonNegativeInt,
  provider: Schema.String,
  model: Schema.NullOr(Schema.String),
  modelSource: Schema.Literals(["request", "response"]),
  error: Schema.Boolean,
  inputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  cacheReadTokens: Schema.NullOr(NonNegativeInt),
  cacheWriteTokens: Schema.NullOr(NonNegativeInt),
});
const decodeReceipt = Schema.decodeUnknownSync(Receipt);
type Receipt = typeof Receipt.Type;
const DAY_MS = 86_400_000;
export const USAGE_JOURNAL_MAX_BYTES = 16 * 1024 * 1024;

export class InvalidGatewayUsageQuery extends Error {}

export const usageWindow = (input: WorkjetGatewayUsageInput, now: number) => {
  const timeZone = input.timeZone ?? "UTC";
  if (timeZone.length > 100 || /^[+-]/.test(timeZone))
    throw new InvalidGatewayUsageQuery("invalid timezone");
  // Intl validates IANA identifiers and supplies a canonical spelling.
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw new InvalidGatewayUsageQuery("invalid timezone");
  }

  const date = (timestamp: number) => {
    const parts = formatter.formatToParts(timestamp);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((entry) => entry.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const endDate = date(now);
  const startDate = new Date(Date.parse(`${endDate}T00:00:00Z`) - (input.days - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return { date, startDate, endDate, timeZone: formatter.resolvedOptions().timeZone };
};
const emptyCounters = (): WorkjetGatewayUsageCounters => ({
  requests: 0,
  errors: 0,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  inputMeasuredRequests: 0,
  outputMeasuredRequests: 0,
  cacheReadMeasuredRequests: 0,
  cacheWriteMeasuredRequests: 0,
  responseModelRequests: 0,
});
const add = (
  counters: WorkjetGatewayUsageCounters,
  receipt: Receipt,
): WorkjetGatewayUsageCounters => ({
  requests: counters.requests + 1,
  errors: counters.errors + Number(receipt.error),
  responseModelRequests:
    counters.responseModelRequests + Number(receipt.modelSource === "response"),
  inputTokens:
    receipt.inputTokens === null
      ? counters.inputTokens
      : (counters.inputTokens ?? 0) + receipt.inputTokens,
  outputTokens:
    receipt.outputTokens === null
      ? counters.outputTokens
      : (counters.outputTokens ?? 0) + receipt.outputTokens,
  cacheReadTokens:
    receipt.cacheReadTokens === null
      ? counters.cacheReadTokens
      : (counters.cacheReadTokens ?? 0) + receipt.cacheReadTokens,
  cacheWriteTokens:
    receipt.cacheWriteTokens === null
      ? counters.cacheWriteTokens
      : (counters.cacheWriteTokens ?? 0) + receipt.cacheWriteTokens,
  inputMeasuredRequests: counters.inputMeasuredRequests + Number(receipt.inputTokens !== null),
  outputMeasuredRequests: counters.outputMeasuredRequests + Number(receipt.outputTokens !== null),
  cacheReadMeasuredRequests:
    counters.cacheReadMeasuredRequests + Number(receipt.cacheReadTokens !== null),
  cacheWriteMeasuredRequests:
    counters.cacheWriteMeasuredRequests + Number(receipt.cacheWriteTokens !== null),
});

/** Read only the UTC journals overlapping the local calendar window. */
export const readGatewayUsage = async (
  input: WorkjetGatewayUsageInput,
  now: number,
  readDay: (utcDay: number) => Promise<string | null>,
): Promise<WorkjetGatewayUsage> => {
  const window = usageWindow(input, now);
  const daily = new Map<string, WorkjetGatewayUsage["daily"][number]>();
  const models = new Map<string | null, WorkjetGatewayUsage["modelTotals"][number]>();
  const providers = new Map<string, WorkjetGatewayUsage["providerTotals"][number]>();
  let totals = emptyCounters();
  let recorded = false;
  // IANA offsets span -12 to +14. One UTC day on either side is sufficient,
  // including DST transitions and local windows crossing UTC midnight.
  const first = Math.floor(Date.parse(`${window.startDate}T00:00:00Z`) / DAY_MS) - 1;
  const last = Math.floor(now / DAY_MS);
  for (let utcDay = first; utcDay <= last; utcDay += 1) {
    const text = await readDay(utcDay);
    if (text === null) continue;
    recorded = true;
    // Appends are fsynced by the host. A concurrent in-progress final line is
    // deferred until the next read; malformed complete lines are an error.
    const end = text.lastIndexOf("\n");
    for (const line of text.slice(0, end < 0 ? 0 : end).split("\n")) {
      if (line === "") continue;
      const receipt = decodeReceipt(JSON.parse(line));
      if (receipt.completedAtMs > now) continue;
      const date = window.date(receipt.completedAtMs);
      if (date < window.startDate || date > window.endDate) continue;
      const key = JSON.stringify([date, receipt.provider, receipt.model]);
      daily.set(key, {
        date,
        provider: receipt.provider,
        model: receipt.model,
        ...add(daily.get(key) ?? emptyCounters(), receipt),
      });
      models.set(receipt.model, {
        model: receipt.model,
        ...add(models.get(receipt.model) ?? emptyCounters(), receipt),
      });
      providers.set(receipt.provider, {
        provider: receipt.provider,
        ...add(providers.get(receipt.provider) ?? emptyCounters(), receipt),
      });
      totals = add(totals, receipt);
    }
  }
  return {
    schemaVersion: 1,
    observedAtMs: now,
    days: input.days,
    timeZone: window.timeZone,
    startDate: window.startDate,
    endDate: window.endDate,
    availability: recorded ? "recorded" : "not-collected-yet",
    daily: [...daily.values()].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.model ?? "").localeCompare(b.model ?? "") ||
        a.provider.localeCompare(b.provider),
    ),
    modelTotals: [...models.values()].sort((a, b) => (a.model ?? "").localeCompare(b.model ?? "")),
    providerTotals: [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    totals,
  };
};
