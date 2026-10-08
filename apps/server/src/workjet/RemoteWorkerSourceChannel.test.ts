// @effect-diagnostics globalFetch:off globalDate:off -- Real loopback socket lifecycle tests exercise the Node listener and wall-clock capability expiry.
import { assert, describe, expect, it } from "@effect/vitest";
import { openWorkerSourceChannel, type WorkerSourceRoute } from "./RemoteWorkerSourceChannel.ts";
import { installWorkerSourceRoute } from "./WorkerSourceHarness.ts";
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
