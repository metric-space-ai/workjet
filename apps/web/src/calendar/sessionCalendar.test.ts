import { describe, expect, it } from "vite-plus/test";
import { createSessionCalendarReader } from "./sessionCalendar";
import type { CtoxWorkjetSessionControlResult } from "@workjet/contracts";

const completed: CtoxWorkjetSessionControlResult = {
  _tag: "completed",
  response: { action: "session.list", sessions: [] },
};
describe("calendar session reads", () => {
  it("coalesces a burst and never publishes a late response after disposal", async () => {
    let resolve!: (result: CtoxWorkjetSessionControlResult) => void;
    const read = () =>
      new Promise<CtoxWorkjetSessionControlResult>((done) => {
        resolve = done;
      });
    const statuses: string[] = [];
    const reader = createSessionCalendarReader(
      "instance-a",
      (value) => statuses.push(value.status),
      read,
    );
    const first = reader.refresh();
    await reader.refresh();
    await reader.refresh();
    expect(statuses).toEqual(["loading"]);
    reader.dispose();
    resolve(completed);
    await first;
    expect(statuses).toEqual(["loading"]);
  });
  it("returns an explicit unavailable state instead of pretending a failed read is empty", async () => {
    const statuses: string[] = [];
    const reader = createSessionCalendarReader(
      "instance-a",
      (value) => statuses.push(value.status),
      async () => ({ _tag: "failed", code: "not_active" }),
    );
    await reader.refresh();
    expect(statuses).toEqual(["loading", "unavailable"]);
    reader.dispose();
  });
});
