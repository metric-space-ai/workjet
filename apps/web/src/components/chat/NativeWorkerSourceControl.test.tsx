import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  WorkjetConnectionId,
  type WorkjetConnectionSummary,
} from "@workjet/contracts";
import { withWorkerSourceConnection } from "../../workjetWorkerSourceConnection";
import { NativeWorkerSourceControl } from "./NativeWorkerSourceControl";

const state = vi.hoisted(() => ({
  data: { connections: [] as WorkjetConnectionSummary[] },
  isPending: false,
  refresh: vi.fn(),
  effects: [] as Array<() => void>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void) => {
    state.effects.push(effect);
  },
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
const props: ComponentProps<typeof NativeWorkerSourceControl> = {
  environmentId: EnvironmentId.make("source-environment"),
  instanceId: `managed:${tenant}`,
  config: DEFAULT_WORKJET_THREAD_CONFIG,
  bindConnection: vi.fn(async () => ({ _tag: "saved" as const })),
  unavailable: false,
};
const render = (overrides: Partial<typeof props> = {}) =>
  renderToStaticMarkup(<NativeWorkerSourceControl {...props} {...overrides} />);
const boundConfig = withWorkerSourceConnection(props.config, props.instanceId, connection)!;
const provision = vi.fn(async () => ({ _tag: "completed", connection }));
beforeEach(() => {
  state.data = { connections: [] };
  state.isPending = false;
  state.effects = [];
  state.refresh.mockClear();
  provision.mockClear();
  vi.mocked(props.bindConnection).mockClear();
  vi.stubGlobal("window", { desktopBridge: { ctox: { provisionDecisionHub: provision } } });
});
afterEach(() => vi.unstubAllGlobals());

describe("automatic supervisor worker connection", () => {
  it("keeps an already-ready binding when another grant exists", () => {
    state.data = {
      connections: [
        connection,
        {
          ...connection,
          connectionId: WorkjetConnectionId.make(
            `ctox-dev-worker-source:${tenant}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
          ),
        },
      ],
    };
    const html = render({ config: boundConfig });
    expect(html).toContain(`data-workjet-worker-source-connection-id="${connection.connectionId}"`);
    expect(html).not.toContain("Erneut verbinden");
  });

  it("shows an actionable ambiguity without a reconnect button or another grant", () => {
    state.data = {
      connections: [
        { ...connection, status: "needs_auth" },
        {
          ...connection,
          connectionId: WorkjetConnectionId.make(
            `ctox-dev-worker-source:${tenant}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
          ),
        },
        {
          ...connection,
          connectionId: WorkjetConnectionId.make(
            `ctox-dev-worker-source:${tenant}:dddddddd-dddd-4ddd-8ddd-dddddddddddd`,
          ),
        },
      ],
    };
    const html = render({ config: boundConfig });
    expect(html).toContain("Multiple authorized worker connections");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Erneut verbinden");
    state.effects.forEach((effect) => effect());
    expect(provision).not.toHaveBeenCalled();
    expect(props.bindConnection).not.toHaveBeenCalled();
  });

  it("displays an immutable-instance rejection instead of offering a doomed retry", () => {
    state.data = { connections: [{ ...connection, instanceId: "foreign.ctox.dev" }] };
    const html = render({ config: boundConfig });
    expect(html).toContain("original CTOX instance and tenant");
    expect(html).not.toContain("Erneut verbinden");
    state.effects.forEach((effect) => effect());
    expect(props.bindConnection).not.toHaveBeenCalled();
  });

  it("removes the lone Connect workers button and attempts setup once on opening", async () => {
    expect(render()).not.toContain("Connect workers");
    for (const effect of state.effects) {
      effect();
      effect();
    }
    expect(provision).toHaveBeenCalledTimes(1);
    await provision.mock.results[0]!.value;
    await Promise.resolve();
    expect(props.bindConnection).toHaveBeenCalledWith(connection);
  });
  it("retains the actual native pin after binding without an extra success banner", () => {
    state.data = { connections: [connection] };
    const html = render({ config: boundConfig });
    expect(html).toContain(`data-workjet-worker-source-instance-id="${nativeInstance}"`);
    expect(html).toContain(`data-workjet-worker-source-connection-id="${connection.connectionId}"`);
    expect(html).not.toContain("Workers connected");
    state.effects.forEach((effect) => effect());
    expect(provision).not.toHaveBeenCalled();
  });
  it("does not display another tenant's saved connection", () => {
    state.data = { connections: [connection] };
    expect(render({ config: boundConfig, instanceId: "managed:foreign" })).not.toContain(
      nativeInstance,
    );
  });
  it("waits for available environment and query before auto-provisioning", () => {
    render({ unavailable: true });
    state.effects.forEach((effect) => effect());
    expect(provision).not.toHaveBeenCalled();
    state.effects = [];
    state.isPending = true;
    render();
    state.effects.forEach((effect) => effect());
    expect(provision).not.toHaveBeenCalled();
  });
  it("uses an existing ready connection without issuing another grant", async () => {
    state.data = { connections: [connection] };
    render();
    state.effects.forEach((effect) => effect());
    expect(props.bindConnection).toHaveBeenCalledWith(connection);
    expect(provision).not.toHaveBeenCalled();
  });
});

it("shows reconnect for a previously bound source whose authorization was rejected", () => {
  state.data = {
    connections: [{ ...connection, status: "needs_auth", reason: "authentication-required" }],
  };
  const html = render({ config: boundConfig });
  expect(html).toContain('aria-label="Reconnect project workers"');
  expect(html).toContain("Worker connection needs authorization.");
  expect(html).not.toContain("data-workjet-worker-source-connection-id=");
  expect(html).not.toContain("data-workjet-worker-source-instance-id=");
});
