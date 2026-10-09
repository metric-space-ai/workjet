import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, WorkjetConnectionId, type WorkjetConnectionSummary } from "@workjet/contracts";
import { NativeWorkerSourceControl } from "./NativeWorkerSourceControl";

const state = vi.hoisted(() => ({
  data: { connections: [] as WorkjetConnectionSummary[] },
  error: null,
  isPending: false,
  refresh: vi.fn(),
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => state }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { workjetDecisionHubConnections: vi.fn(() => null) },
}));

const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nativeInstance = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const connection: WorkjetConnectionSummary = {
  connectionId: WorkjetConnectionId.make(`ctox-dev-worker-source:${tenant}:${nativeInstance}`),
  instanceId: nativeInstance,
  displayName: "Project workers",
  source: "ctox_dev",
  status: "ready",
  reason: null,
};
const props = {
  environmentId: EnvironmentId.make("source-environment"),
  instanceId: `managed:${tenant}`,
  unavailable: false,
};
const render = (overrides: Partial<typeof props> = {}) =>
  renderToStaticMarkup(<NativeWorkerSourceControl {...props} {...overrides} />);

beforeEach(() => {
  state.data = { connections: [] };
  state.isPending = false;
  state.refresh.mockClear();
  vi.stubGlobal("window", { desktopBridge: { ctox: { provisionDecisionHub: vi.fn() } } });
});
afterEach(() => vi.unstubAllGlobals());

describe("worker connection in the native project supervisor", () => {
  it("offers Connect workers without a coding-chat tool configuration", () => {
    const html = render();
    expect(html).toContain('aria-label="Connect workers for this project"');
    expect(html.match(/<button[^>]*>/)?.[0]).not.toContain("disabled");
    expect(html).not.toContain("Workers connected");
  });
  it("shows only the actual native pin and source connection when ready", () => {
    state.data = { connections: [connection] };
    const html = render();
    expect(html).toContain("Workers connected");
    expect(html).toContain(`data-workjet-worker-source-instance-id="${nativeInstance}"`);
    expect(html).toContain(`data-workjet-worker-source-connection-id="${connection.connectionId}"`);
    expect(html).not.toContain("Connect workers for this project");
    expect(html).not.toContain(`data-workjet-worker-source-instance-id="${tenant}"`);
  });
  it("does not report decision-hub grants or another tenant as connected workers", () => {
    state.data = { connections: [{ ...connection, connectionId: WorkjetConnectionId.make(`ctox-dev:${tenant}`) }] };
    expect(render()).not.toContain("Workers connected");
    state.data = { connections: [connection] };
    expect(render({ instanceId: "managed:foreign" })).not.toContain("Workers connected");
    expect(render({ instanceId: "managed:foreign" })).not.toContain(nativeInstance);
  });
  it("lets an unavailable source be connected again without declaring it ready", () => {
    state.data = { connections: [{ ...connection, status: "unavailable" }] };
    const html = render();
    expect(html).not.toContain("Workers connected");
    expect(html.match(/<button[^>]*>/)?.[0]).not.toContain("disabled");
  });
  it("prevents provisioning when the environment or its connection list is unavailable", () => {
    expect(render({ unavailable: true }).match(/<button[^>]*>/)?.[0]).toContain("disabled");
    state.isPending = true;
    expect(render().match(/<button[^>]*>/)?.[0]).toContain("disabled");
  });
  it("explains that grant issuance is a desktop action when no bridge is present", () => {
    vi.stubGlobal("window", {});
    const html = render();
    expect(html).toContain("Connect workers in the desktop app.");
    expect(html.match(/<button[^>]*>/)?.[0]).toContain("disabled");
  });
  it("requires a real managed selection instead of deriving a tenant from a native instance", () => {
    const html = render({ instanceId: nativeInstance });
    expect(html).toContain("Select a managed Business OS to connect workers.");
    expect(html.match(/<button[^>]*>/)?.[0]).toContain("disabled");
  });
});
