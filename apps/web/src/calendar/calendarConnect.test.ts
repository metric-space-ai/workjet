import { describe, expect, it, vi } from "vite-plus/test";

import type { CtoxWorkjetProjectControlRequest } from "@workjet/contracts";
import {
  CALENDAR_CONNECT_FAILURES,
  connectGoogleCalendar,
  probeCalendarConnect,
  type CalendarAuthorizePort,
} from "./calendarConnect";
import { requestWorkjetProjectControl } from "../workjetProjectControl";

const INSTANCE = "managed:selected-tenant";
const ATTEMPT = "7f2d4c1e-8b9a-4c3d-9e1f-2a3b4c5d6e7f";
const REDIRECT = "https://tenant.ctox.dev/google/oauth/callback";
const CALLBACK = `${REDIRECT}?state=s1&code=one-time`;
const ACCOUNT = {
  id: "owner@example.test",
  label: "Owner",
  provider: "google" as const,
  calendar_id: "account:abc",
  supported: true as const,
};
const startReceipt = {
  attemptId: ATTEMPT,
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s1",
  redirectUri: REDIRECT,
  scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.readonly"],
  expiresAtMs: 1_800_000_600_000,
};

type Reply = Record<string, unknown> | "unsupported" | "core_outdated";
function mockCore(replies: { start?: Reply; complete?: Reply; probe?: Reply }) {
  return vi.fn<typeof requestWorkjetProjectControl>().mockImplementation(async (_, request) => {
    const r = request as CtoxWorkjetProjectControlRequest & Record<string, unknown>;
    const reply =
      r.action === "project.calendar.account.connect.start"
        ? r.provider === "google"
          ? replies.start
          : replies.probe
        : r.action === "project.calendar.account.connect.complete"
          ? replies.complete
          : undefined;
    if (reply === undefined || reply === "unsupported")
      return { _tag: "failed", code: "unsupported" };
    if (reply === "core_outdated")
      return {
        _tag: "failed",
        code: "guest_failed",
        diagnostic: { stage: "execute", reason: "core_outdated" },
      };
    return {
      _tag: "completed",
      response: { action: r.action, commandId: r.commandId, ...reply },
    } as Awaited<ReturnType<typeof requestWorkjetProjectControl>>;
  });
}
const captured: CalendarAuthorizePort = async () => ({ _tag: "captured", callbackUrl: CALLBACK });

describe("Google Kalender verbinden über die Instanz (ctox #875)", () => {
  it("start → Anmeldefenster → complete: nur callbackUrl geht an den Core", async () => {
    const control = mockCore({ start: startReceipt, complete: { account: ACCOUNT } });
    const authorize = vi.fn<CalendarAuthorizePort>(captured);
    const outcome = await connectGoogleCalendar(INSTANCE, {
      authorize,
      current: () => true,
      control,
    });
    expect(outcome).toEqual({ _tag: "connected", account: ACCOUNT });
    const [start, complete] = control.mock.calls.map((call) => call[1]);
    expect(start).toMatchObject({
      action: "project.calendar.account.connect.start",
      provider: "google",
    });
    expect(Object.keys(start!).toSorted()).toEqual(["action", "commandId", "provider"]);
    expect(authorize).toHaveBeenCalledWith({
      instanceId: INSTANCE,
      authorizeUrl: startReceipt.authorizeUrl,
      redirectUri: REDIRECT,
    });
    expect(complete).toMatchObject({
      action: "project.calendar.account.connect.complete",
      attemptId: ATTEMPT,
      callbackUrl: CALLBACK,
    });
    expect(Object.keys(complete!).toSorted()).toEqual([
      "action",
      "attemptId",
      "callbackUrl",
      "commandId",
    ]);
    expect(control.mock.calls.every((call) => call[0] === INSTANCE)).toBe(true);
  });

  it("meldet jeden Core-Fehlercode als eigene Zeile mit genau einer Aktion", async () => {
    for (const code of [
      "provider_unsupported",
      "oauth_client_missing",
      "redirect_unavailable",
      "permission_denied",
      "rate_limited",
    ] as const) {
      const control = mockCore({ start: { error: code } });
      const authorize = vi.fn<CalendarAuthorizePort>(captured);
      expect(
        await connectGoogleCalendar(INSTANCE, { authorize, current: () => true, control }),
      ).toEqual({ _tag: "failed", code });
      expect(authorize).not.toHaveBeenCalled();
    }
    for (const code of [
      "attempt_expired",
      "state_mismatch",
      "consent_denied",
      "scope_missing",
      "token_exchange_failed",
      "account_exists",
    ] as const) {
      const control = mockCore({ start: startReceipt, complete: { error: code } });
      expect(
        await connectGoogleCalendar(INSTANCE, {
          authorize: captured,
          current: () => true,
          control,
        }),
      ).toEqual({ _tag: "failed", code });
    }
    for (const failure of Object.values(CALENDAR_CONNECT_FAILURES)) {
      expect(failure.text.length).toBeLessThanOrEqual(60);
      expect(["retry", "dismiss"]).toContain(failure.action);
    }
  });

  it("schließt der Nutzer das Fenster, ist das kein Fehler und complete läuft nicht", async () => {
    const control = mockCore({ start: startReceipt, complete: { account: ACCOUNT } });
    const outcome = await connectGoogleCalendar(INSTANCE, {
      authorize: async () => ({ _tag: "cancelled" }),
      current: () => true,
      control,
    });
    expect(outcome).toEqual({ _tag: "cancelled" });
    expect(control).toHaveBeenCalledTimes(1);
    expect(
      await connectGoogleCalendar(INSTANCE, {
        authorize: async () => ({ _tag: "failed" }),
        current: () => true,
        control,
      }),
    ).toEqual({ _tag: "failed", code: "authorize_failed" });
  });

  it("verwirft fremde oder unkorrelierte Antworten", async () => {
    const foreign = vi.fn<typeof requestWorkjetProjectControl>().mockImplementation(
      async (_, r) =>
        ({
          _tag: "completed",
          response: {
            action: r.action,
            commandId: "other-command",
            ...startReceipt,
          },
        }) as unknown as Awaited<ReturnType<typeof requestWorkjetProjectControl>>,
    );
    expect(
      await connectGoogleCalendar(INSTANCE, {
        authorize: captured,
        current: () => true,
        control: foreign,
      }),
    ).toEqual({ _tag: "failed", code: "instance_unavailable" });
    const leaky = mockCore({ start: { ...startReceipt, accessToken: "secret" } });
    expect(
      await connectGoogleCalendar(INSTANCE, {
        authorize: captured,
        current: () => true,
        control: leaky,
      }),
    ).toEqual({ _tag: "failed", code: "instance_unavailable" });
  });

  it("sperrt späte Antworten nach einem Instanzwechsel", async () => {
    let live = true;
    const control = mockCore({ start: startReceipt, complete: { account: ACCOUNT } });
    await expect(
      connectGoogleCalendar(INSTANCE, {
        authorize: async () => {
          live = false;
          return { _tag: "captured", callbackUrl: CALLBACK };
        },
        current: () => live,
        control,
      }),
    ).rejects.toThrow("Calendar instance changed.");
    expect(control).toHaveBeenCalledTimes(1);
  });
});

describe("Capability-Schutz", () => {
  it("zeigt den Eintrag nur, wenn der Core die Probe mit provider_unsupported beantwortet", async () => {
    const known = mockCore({ probe: { error: "provider_unsupported" } });
    expect(await probeCalendarConnect(INSTANCE, known)).toBe(true);
    const probe = known.mock.calls[0]![1] as Record<string, unknown>;
    expect(probe).toMatchObject({
      action: "project.calendar.account.connect.start",
      provider: "capability-probe",
    });
  });

  it("blendet bei unsupported, core_outdated, fehlender Berechtigung und Ausfall aus", async () => {
    for (const probe of ["unsupported", "core_outdated", { error: "permission_denied" }] as const) {
      expect(await probeCalendarConnect(INSTANCE, mockCore({ probe }))).toBe(false);
    }
    const broken = vi.fn<typeof requestWorkjetProjectControl>().mockRejectedValue(new Error("x"));
    expect(await probeCalendarConnect(INSTANCE, broken)).toBe(false);
  });
});
