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
  connect: null as { current: (renew?: boolean, connectionId?: string) => Promise<void> } | null,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void) => {
    state.effects.push(effect);
  },
  useRef: (value: unknown) => {
    const ref = { current: value };
    if (typeof value === "function")
      state.connect = ref as { current: (renew?: boolean, connectionId?: string) => Promise<void> };
    return ref;
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
  state.connect = null;
  state.refresh.mockClear();
  provision.mockClear();
  vi.mocked(props.bindConnection).mockClear();
  vi.stubGlobal("window", { desktopBridge: { ctox: { provisionDecisionHub: provision } } });
});
afterEach(() => vi.unstubAllGlobals());

describe("automatic supervisor worker connection", () => {
  it("reports one authentication recovery status while rendering headlessly", () => {
    state.data = {
      connections: [{ ...connection, status: "needs_auth", reason: "Sign in again." }],
    };
    const onStatusChange = vi.fn();
    expect(render({ config: boundConfig, headless: true, onStatusChange })).toBe("");
    state.effects.forEach((effect) => effect());
    expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticationRequired: true,
        message: expect.any(String),
      }),
    );
    expect(provision).toHaveBeenCalledOnce();
  });
  it("renews a ready source only on the explicit user action and saves the issued binding", async () => {
    state.data = { connections: [connection] };
    const replacement = {
      ...connection,
      connectionId: WorkjetConnectionId.make(
        `ctox-dev-worker-source:${tenant}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
      ),
    };
    provision.mockResolvedValueOnce({ _tag: "completed", connection: replacement });
    const html = render({ config: boundConfig });
    expect(html).not.toContain('aria-label="Renew worker access"');
    state.effects.forEach((effect) => effect());
    expect(provision).not.toHaveBeenCalled();
    await state.connect!.current(true);
    expect(provision).toHaveBeenCalledExactlyOnceWith({
      environmentId: props.environmentId,
      purpose: "worker_source",
      target: { _tag: "ctox_dev", tenantId: tenant },
    });
    expect(props.bindConnection).toHaveBeenCalledExactlyOnceWith(replacement);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.data.connections).toEqual([connection]);
  });

  it("does not renew an unavailable environment or bind an issued foreign instance", async () => {
    state.data = { connections: [connection] };
    render({ config: boundConfig, unavailable: true });
    await state.connect!.current(true);
    expect(provision).not.toHaveBeenCalled();
    provision.mockResolvedValueOnce({
      _tag: "completed",
      connection: { ...connection, instanceId: "foreign.ctox.dev" },
    });
    render({ config: boundConfig });
    await state.connect!.current(true);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(props.bindConnection).not.toHaveBeenCalled();
  });

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
    expect(html).not.toContain('aria-label="Choose worker access"');
  });

  it("offers an explicit same-instance choice for an expired binding without issuing another grant", async () => {
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
    expect(html).toContain('aria-label="Choose worker access"');
    expect(html).toContain("cccccccc");
    expect(html).toContain("dddddddd");
    expect(html).not.toContain("Erneut verbinden");
    state.effects.forEach((effect) => effect());
    expect(provision).not.toHaveBeenCalled();
    expect(props.bindConnection).not.toHaveBeenCalled();
    await state.connect!.current(false, state.data.connections[2]!.connectionId);
    expect(props.bindConnection).toHaveBeenCalledExactlyOnceWith(state.data.connections[2]);
    expect(provision).not.toHaveBeenCalled();
    expect(state.data.connections[1]!.status).toBe("ready");
  });

  it("binds a new chat to the explicitly chosen ready grant and never guesses or renews", async () => {
    const replacement = {
      ...connection,
      connectionId: WorkjetConnectionId.make(
        `ctox-dev-worker-source:${tenant}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
      ),
    };
    state.data = { connections: [connection, replacement] };
    const html = render();
    expect(html).toContain('aria-label="Choose worker access"');
    state.effects.forEach((effect) => effect());
    expect(props.bindConnection).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    await state.connect!.current(false, replacement.connectionId);
    expect(props.bindConnection).toHaveBeenCalledExactlyOnceWith(replacement);
    expect(provision).not.toHaveBeenCalled();
    expect(state.data.connections).toEqual([connection, replacement]);
  });

  it("rejects explicit choices outside the ready selected-instance catalog", async () => {
    const foreign = {
      ...connection,
      connectionId: WorkjetConnectionId.make(
        "ctox-dev-worker-source:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ),
      instanceId: "foreign.ctox.dev",
    };
    state.data = { connections: [foreign] };
    render();
    await state.connect!.current(false, foreign.connectionId);
    await state.connect!.current(false, "missing");
    expect(props.bindConnection).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    const retargeted = { ...connection, instanceId: "foreign.ctox.dev" };
    state.data = { connections: [retargeted] };
    render({ config: boundConfig });
    await state.connect!.current(false, retargeted.connectionId);
    expect(props.bindConnection).not.toHaveBeenCalled();
    state.data = { connections: [{ ...connection, status: "needs_auth" }] };
    render();
    await state.connect!.current(false, connection.connectionId);
    expect(props.bindConnection).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("does not select or issue a grant while the environment is unavailable", async () => {
    const replacement = {
      ...connection,
      connectionId: WorkjetConnectionId.make(
        `ctox-dev-worker-source:${tenant}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
      ),
    };
    state.data = { connections: [connection, replacement] };
    expect(render({ unavailable: true })).toContain('aria-label="Choose worker access"');
    await state.connect!.current(false, replacement.connectionId);
    expect(props.bindConnection).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
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

  it("keeps recovery visible when a saved source expires and its replacement is already ready", () => {
    const replacement = {
      ...connection,
      connectionId: WorkjetConnectionId.make(
        `ctox-dev-worker-source:${tenant}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
      ),
    };
    state.data = {
      connections: [
        { ...connection, status: "needs_auth", reason: "authentication-required" },
        replacement,
      ],
    };
    const html = render({ config: boundConfig });
    expect(html).toContain('aria-label="Reconnect project workers"');
    expect(html).toContain("A replacement worker connection is ready.");
    expect(html).not.toContain("data-workjet-worker-source-connection-id=");
    state.effects.forEach((effect) => effect());
    expect(props.bindConnection).toHaveBeenCalledExactlyOnceWith(replacement);
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
