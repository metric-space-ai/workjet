// @effect-diagnostics globalFetch:off globalDate:off -- Real loopback socket lifecycle tests exercise the Node listener and wall-clock capability expiry.
import { assert, describe, expect, it } from "@effect/vitest";
import { openWorkerSourceChannel, type WorkerSourceRoute } from "./RemoteWorkerSourceChannel.ts";
import { installWorkerSourceRoute } from "./WorkerSourceHarness.ts";
it("replays a lost retirement acknowledgement without inference or a second source mutation", async () => {
  const channel = await openWorkerSourceChannel();
  let retired = false;
  let calls = 0;
  const route = channel.issue({
    ...identity,
    requestId: "lost-terminal-ack",
    expiresAtMs: Date.now() + 60_000,
    onRetired: () => {
      retired = true;
    },
    invoke: async (operation) => {
      assert.equal(operation, "retire");
      calls++;
      return { retired: true };
    },
  });
  const payload = { pullRequest: { number: 305 }, headOid: "a".repeat(40) };
  const invoke = (operation: string, value = payload) =>
    post(route, { requestId: route.requestId, operation, payload: value });
  try {
    const first = await invoke("retire");
    await first.body?.cancel();
    assert.equal(retired, false);
    const replay = await invoke("retire");
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { retired: true });
    assert.equal((await invoke("infer")).status, 400);
    assert.equal((await invoke("retire", { ...payload, headOid: "b".repeat(40) })).status, 400);
    assert.equal(calls, 1);
    assert.equal(retired, false);
    const confirmation = await invoke("retirementAck");
    assert.equal(confirmation.status, 200);
    await confirmation.json();
    assert.equal(retired, true);
    assert.equal((await invoke("retire")).status, 401);
  } finally {
    await channel.close();
  }
});
it("terminal retirement revokes the source capability after its acknowledgement", async () => {
  const channel = await openWorkerSourceChannel();
  let finished!: () => void;
  const retired = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const calls: string[] = [];
  const route = channel.issue({
    ...identity,
    requestId: "worker-terminal",
    expiresAtMs: Date.now() + 60_000,
    onRetired: finished,
    invoke: async (operation) => {
      calls.push(operation);
      if (operation !== "retire") throw new Error("model grant already revoked");
      return { retired: true };
    },
  });
  const harness = await installWorkerSourceRoute(route.requestId, route, {
    targetEnvironmentId: route.targetEnvironmentId,
    requestDigest: route.requestDigest,
    modelId: "worker-model",
  });
  try {
    await harness.retire();
    await retired;
    assert.deepEqual(calls, ["retire"]);
    assert.equal(
      (await post(route, { requestId: route.requestId, operation: "admit" })).status,
      401,
    );
    await expect(harness.admit()).rejects.toThrow("Worker route revoked");
  } finally {
    await harness.revoke();
    await channel.close();
  }
});

const identity = {
  sourceEnvironmentId: "source",
  targetEnvironmentId: "gpu3",
  requestId: "worker-one",
  requestDigest: "a".repeat(64),
};
const post = (route: WorkerSourceRoute, override: Record<string, unknown> = {}) =>
  fetch(`http://127.0.0.1:${route.port}/worker-source`, {
    method: "POST",
    headers: { authorization: `Bearer ${route.capability}`, "content-type": "application/json" },
    body: JSON.stringify({
      ...identity,
      operation: "infer",
      payload: { input: "Hi" },
      ...override,
    }),
  });

describe("Node-owned worker source channel", () => {
  it("requires live worker admission for source computer discovery", async () => {
    const channel = await openWorkerSourceChannel();
    const calls: string[] = [];
    let authorized = true;
    const route = channel.issue({
      ...identity,
      expiresAtMs: Date.now() + 60_000,
      invoke: async (operation) => {
        calls.push(operation);
        if (!authorized) throw new Error("revoked native authority");
        return operation === "computers" ? { schemaVersion: 1, computers: [] } : { admitted: true };
      },
    });
    try {
      assert.equal(
        (await post(route, { operation: "computers", targetEnvironmentId: "foreign" })).status,
        403,
      );
      assert.deepEqual(calls, []);
      const response = await post(route, { operation: "computers" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { schemaVersion: 1, computers: [] });
      assert.deepEqual(calls, ["admit", "computers"]);
      authorized = false;
      assert.equal((await post(route, { operation: "computers" })).status, 400);
      assert.deepEqual(calls, ["admit", "computers", "admit"]);
      channel.revoke(route.requestId);
      assert.equal((await post(route, { operation: "computers" })).status, 401);
    } finally {
      await channel.close();
    }
  });
  it("pins request identity and checks live admission before each inference", async () => {
    const channel = await openWorkerSourceChannel();
    const calls: string[] = [];
    let authorized = true;
    try {
      const input = {
        ...identity,
        expiresAtMs: Date.now() + 60_000,
        invoke: async (operation: string) => {
          calls.push(operation);
          if (!authorized) throw new Error("revoked native authority");
          return { status: "ok" };
        },
      };
      const route = channel.issue(input);
      assert.deepEqual(channel.issue(input), route);
      assert.throws(() => channel.issue({ ...input, requestDigest: "b".repeat(64) }));
      assert.equal((await post(route, { targetEnvironmentId: "foreign" })).status, 403);
      assert.equal((await post(route, { operation: "server.updateSettings" })).status, 403);
      assert.deepEqual(calls, []);
      const success = await post(route);
      assert.equal(success.status, 200);
      assert.equal(
        success.headers.get("x-workjet-source-environment"),
        identity.sourceEnvironmentId,
      );
      assert.equal(success.headers.get("x-workjet-worker-digest"), identity.requestDigest);
      assert.deepEqual(await success.json(), { status: "ok" });
      assert.deepEqual(calls, ["admit", "infer"]);
      authorized = false;
      assert.equal((await post(route)).status, 400);
      assert.deepEqual(calls, ["admit", "infer", "admit"]);
      channel.revoke(route.requestId);
      assert.equal((await post(route)).status, 401);
      assert.throws(() => channel.issue(input));
    } finally {
      await channel.close();
    }
    await channel.close();
  });

  it("aborts in-flight inference on revoke and does not publish a late success", async () => {
    const channel = await openWorkerSourceChannel();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    const route = channel.issue({
      ...identity,
      expiresAtMs: Date.now() + 60_000,
      invoke: async (operation, _payload, currentSignal) => {
        if (operation === "admit") return {};
        signal = currentSignal;
        started();
        return new Promise(() => {});
      },
    });
    try {
      const response = post(route);
      await running;
      channel.revoke(route.requestId);
      assert.equal((await response).status, 503);
      assert.equal(signal?.aborted, true);
    } finally {
      await channel.close();
    }
  });

  it("service close invalidates routes and interrupts workers independently of UI state", async () => {
    const channel = await openWorkerSourceChannel();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    const route = channel.issue({
      ...identity,
      expiresAtMs: Date.now() + 60_000,
      invoke: async (operation, _payload, currentSignal) => {
        if (operation === "admit") return {};
        signal = currentSignal;
        started();
        return new Promise(() => {});
      },
    });
    const response = post(route).catch(() => null);
    await running;
    await channel.close();
    await response;
    assert.equal(signal?.aborted, true);
    assert.throws(() =>
      channel.issue({ ...identity, expiresAtMs: Date.now() + 60_000, invoke: async () => ({}) }),
    );
  });

  it("rejects expired routes and unknown worker capabilities", async () => {
    const channel = await openWorkerSourceChannel();
    try {
      assert.throws(() =>
        channel.issue({ ...identity, expiresAtMs: Date.now() - 1, invoke: async () => ({}) }),
      );
      const route = channel.issue({
        ...identity,
        expiresAtMs: Date.now() + 60_000,
        invoke: async () => ({}),
      });
      assert.equal((await post({ ...route, capability: "foreign" })).status, 401);
    } finally {
      await channel.close();
    }
  });
});
