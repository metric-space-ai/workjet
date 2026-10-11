import { describe, expect, it } from "vite-plus/test";

import { describeSlowRequests } from "./SlowRpcRequestToastCoordinator";

const request = {
  requestId: "request-1",
  startedAt: "1970-01-01T00:00:00.000Z",
  startedAtMs: 0,
  tag: "fleet.inventory",
  thresholdMs: 15_000,
};

describe("slow request copy", () => {
  it("is one German line without a second sentence", () => {
    expect(describeSlowRequests([request])).toBe("1 Anfrage wartet länger als 15 s");
    expect(describeSlowRequests([request, { ...request, requestId: "request-2" }])).toBe(
      "2 Anfragen warten länger als 15 s",
    );
  });

  it("reports the smallest threshold the batch has passed", () => {
    expect(describeSlowRequests([request, { ...request, thresholdMs: 5_000 }])).toBe(
      "2 Anfragen warten länger als 5 s",
    );
  });
});
