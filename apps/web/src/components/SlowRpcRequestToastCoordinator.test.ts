import { describe, expect, it } from "vite-plus/test";

import { describeSlowRequests, resolveSlowRequestLocale } from "./SlowRpcRequestToastCoordinator";

const request = {
  requestId: "request-1",
  startedAt: "1970-01-01T00:00:00.000Z",
  startedAtMs: 0,
  tag: "fleet.inventory",
  thresholdMs: 15_000,
};

describe("slow request copy", () => {
  it("uses one language consistently for German and English locales", () => {
    expect(resolveSlowRequestLocale("de-DE")).toBe("de");
    expect(resolveSlowRequestLocale("en-US")).toBe("en");
    expect(describeSlowRequests([request], "de")).toBe("1 Anfrage wartet länger als 15 s.");
    expect(describeSlowRequests([request, { ...request, requestId: "request-2" }], "de")).toBe(
      "2 Anfragen warten länger als 15 s.",
    );
    expect(describeSlowRequests([request], "en")).toBe("1 request waiting longer than 15s.");
  });
});
