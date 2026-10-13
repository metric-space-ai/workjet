import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  describeSlowRequests,
  SlowRpcRequestChip,
  SlowRpcRequestToastCoordinator,
} from "./SlowRpcRequestToastCoordinator";
import { useClientSettings } from "../hooks/useSettings";
import { useSlowRpcAckRequests } from "../rpc/requestLatencyState";

vi.mock("../rpc/requestLatencyState", async (importOriginal) => {
  const original = await importOriginal<typeof import("../rpc/requestLatencyState")>();
  return { ...original, useSlowRpcAckRequests: vi.fn(() => []) };
});
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../hooks/useSettings")>();
  return { ...original, useClientSettings: vi.fn(() => true) };
});
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => Promise.resolve(),
}));

const request = {
  requestId: "request-1",
  startedAt: "1970-01-01T00:00:00.000Z",
  startedAtMs: 0,
  tag: "fleet.inventory",
  thresholdMs: 15_000,
};

const mockedRequests = (requests: ReadonlyArray<typeof request>) =>
  vi.mocked(useSlowRpcAckRequests).mockReturnValue(requests);

const mockedDeveloperMode = (enabled: boolean) =>
  vi
    .mocked(useClientSettings)
    .mockImplementation(((selector?: (settings: { developerMode: boolean }) => unknown) =>
      selector
        ? selector({ developerMode: enabled })
        : { developerMode: enabled }) as unknown as typeof useClientSettings);

describe("slow request copy", () => {
  it("is one German line without a second sentence", () => {
    expect(describeSlowRequests([request])).toBe("1 Anfrage wartet länger als 15 s");
    expect(describeSlowRequests([request, { ...request, requestId: "request-2" }])).toBe(
      "2 Anfragen warten länger als 15 s",
    );
  });

  it("reports the smallest threshold the batch has passed", () => {
    expect(describeSlowRequests([request, { ...request, thresholdMs: 5_000 }])).toBe(
      "2 Anfragen warten länger als 5 s",
    );
  });
});

describe("slow request header chip", () => {
  it("renders nothing while no request is slow", () => {
    mockedDeveloperMode(true);
    mockedRequests([]);
    expect(renderToStaticMarkup(<SlowRpcRequestChip />)).toBe("");
  });

  it("shows the German line as a chip that points to diagnostics, not a toast", () => {
    mockedDeveloperMode(true);
    mockedRequests([request, { ...request, requestId: "request-2" }]);
    const html = renderToStaticMarkup(<SlowRpcRequestChip />);
    expect(html).toContain('data-workjet-slow-requests=""');
    expect(html).toContain("2 Anfragen warten länger als 15 s");
    expect(html).toContain("Einstellungen › Diagnose");
    expect(html.startsWith("<button")).toBe(true);
  });

  it("stays hidden outside the developer mode (#574)", () => {
    mockedDeveloperMode(false);
    mockedRequests([request]);
    expect(renderToStaticMarkup(<SlowRpcRequestChip />)).toBe("");
  });

  it("keeps the legacy coordinator mount silent", () => {
    mockedRequests([request]);
    expect(renderToStaticMarkup(<SlowRpcRequestToastCoordinator />)).toBe("");
  });
});
