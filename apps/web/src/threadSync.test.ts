import { describe, expect, it } from "vite-plus/test";

import { resolveThreadSyncPhase, THREAD_SYNC_SLOW_LINE } from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("loads when only shell data is available", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
      }),
    ).toBe("loading");
  });

  it("syncs when cached detail is already visible", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
      }),
    ).toBe("syncing");
  });

  it("does not report a sync phase without a shell or after going live", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: false,
        status: "empty",
      }),
    ).toBeNull();
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "live",
      }),
    ).toBeNull();
  });
});

describe("THREAD_SYNC_SLOW_LINE", () => {
  it("is a short German status line", () => {
    expect(THREAD_SYNC_SLOW_LINE).toBe("Nachrichten nicht geladen");
    expect(THREAD_SYNC_SLOW_LINE.split(" ").length).toBeLessThanOrEqual(12);
  });
});
