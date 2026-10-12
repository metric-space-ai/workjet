import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CALENDAR_LOAD_TIMEOUT_MS,
  calendarLoadState,
  startCalendarLoadDeadline,
} from "./calendarLoad";

describe("calendar load deadline (#468)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends a load that has not answered after 10 s", () => {
    vi.useFakeTimers();
    let timedOut = false;
    startCalendarLoadDeadline(() => {
      timedOut = true;
    });
    expect(CALENDAR_LOAD_TIMEOUT_MS).toBe(10_000);
    vi.advanceTimersByTime(9_999);
    expect(calendarLoadState({ loading: true, timedOut, failed: false })).toBe("loading");
    vi.advanceTimersByTime(1);
    expect(timedOut).toBe(true);
    expect(calendarLoadState({ loading: true, timedOut, failed: false })).toBe("failed");
  });

  it("does not fire once the load answered in time", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const cancel = startCalendarLoadDeadline(onExpire);
    vi.advanceTimersByTime(5_000);
    cancel();
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(calendarLoadState({ loading: false, timedOut: false, failed: false })).toBe("ready");
  });

  it("treats a failed read as ended, also without timeout", () => {
    expect(calendarLoadState({ loading: false, timedOut: false, failed: true })).toBe("failed");
  });
});
