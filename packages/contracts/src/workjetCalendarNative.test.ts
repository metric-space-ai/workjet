import { describe, it, expect } from "vite-plus/test";
import * as Schema from "effect/Schema";
import fixture from "./workjetCalendar.fixture.json" with { type: "json" };
import {
  WorkjetCalendarNativeRequests,
  WorkjetCalendarNativeResponses,
  isWorkjetCalendarReceiptForRequest,
} from "./workjetCalendarNative.ts";
const request = Schema.decodeUnknownSync(Schema.Union(WorkjetCalendarNativeRequests), {
  onExcessProperty: "error",
});
const response = Schema.decodeUnknownSync(Schema.Union(WorkjetCalendarNativeResponses), {
  onExcessProperty: "error",
});
describe("calendar reads on the authenticated guest", () => {
  it("accepts and rejects the shared native/browser request fixtures", () => {
    const map = (type: string, value: unknown) => {
      const fields = value as {
        request_id: string;
        account_id?: string;
        start_ms?: number;
        end_ms?: number;
      };
      return type === "CalendarAccountsReadRequest"
        ? { action: "project.calendar.accounts.read", commandId: fields.request_id }
        : {
            action: "project.calendar.events.read",
            commandId: fields.request_id,
            accountId: fields.account_id,
            startMs: fields.start_ms,
            endMs: fields.end_ms,
          };
    };
    for (const item of fixture.valid_cases.filter((item) => item.type.endsWith("ReadRequest")))
      expect(() => request(map(item.type, item.value))).not.toThrow();
    for (const item of fixture.invalid_cases.filter((item) => item.type.endsWith("ReadRequest")))
      expect(() => request(map(item.type, item.value))).toThrow();
    expect(() =>
      request({ action: "project.calendar.accounts.read", commandId: "read-1", actor: "other" }),
    ).toThrow();
    expect(() =>
      request({
        action: "project.calendar.events.read",
        commandId: "read-1",
        accountId: "mine",
        startMs: 0,
        endMs: 401 * 86_400_000,
      }),
    ).toThrow();
  });
  it("rejects substituted command, range, duplicate accounts and foreign event receipts", () => {
    const read = request({
      action: "project.calendar.events.read",
      commandId: "read-1",
      accountId: "mine",
      startMs: 1,
      endMs: 2,
    });
    const receipt = response({
      ...read,
      calendar: { ok: true, events: [], truncated: false, synced_at_ms: 3 },
    });
    expect(isWorkjetCalendarReceiptForRequest(read, receipt)).toBe(true);
    expect(
      isWorkjetCalendarReceiptForRequest(read, {
        ...receipt,
        commandId: "other",
      } as typeof receipt),
    ).toBe(false);
    expect(
      isWorkjetCalendarReceiptForRequest(read, { ...receipt, endMs: 3 } as typeof receipt),
    ).toBe(false);
    const account = { id: "mine", calendar_id: "account:mine", label: "Calendar", supported: true };
    expect(() =>
      response({
        action: "project.calendar.accounts.read",
        commandId: "read-1",
        calendar: { ok: true, truncated: false, accounts: [account, account] },
      }),
    ).toThrow();
    const event = fixture.valid_cases.find((item) => item.type === "CalendarEvent")!.value;
    expect(() =>
      response({
        ...read,
        calendar: {
          ok: true,
          truncated: false,
          synced_at_ms: 3,
          events: [{ ...event, kind: "synced", account_id: "foreign" }],
        },
      }),
    ).toThrow();
  });
});
