// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Real loopback HTTP fixture exercises the external Codex transport boundary.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { afterEach, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HostProcessEnvironment, HostProcessPlatform } from "@workjet/shared/hostProcess";
import { installWorkerSourceRoute } from "./WorkerSourceHarness.ts";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it("sends verified submission details and retains the source route after a failed retirement", async () => {
  const notices: unknown[] = [];
  let fail = true;
  const server = NodeHttp.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    notices.push(body.payload);
    res.setHeader("content-type", "application/json");
    if (fail) {
      res.writeHead(503);
      res.end("{}");
    } else res.end(JSON.stringify({ retired: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener");
  const harness = await installWorkerSourceRoute(
    "retirement-retry",
    {
      sourceEnvironmentId: "source",
      targetEnvironmentId: "target",
      requestId: "retirement-retry",
      requestDigest: "immutable-digest",
      capability: "worker-source-capability",
      port: address.port,
    },
    { targetEnvironmentId: "target", requestDigest: "immutable-digest", modelId: "gpt-6.1-sol" },
  );
  cleanups.push(harness.revoke);
  const notice = {
    pullRequest: {
      provider: "github" as const,
      number: 305,
      url: "https://github.com/metric-space-ai/workjet/pull/305",
      branch: "workjet/worker/retirement-retry",
    },
    headOid: "a".repeat(40),
  };
  let stopped = false;
  const persistStopped = async () => {
    stopped = true;
  };
  await expect(harness.retire(notice, persistStopped)).rejects.toThrow();
  expect(harness.isRevoked()).toBe(false);
  expect(stopped).toBe(false);
  fail = false;
  await harness.retire(notice, persistStopped);
  expect(harness.isRevoked()).toBe(true);
  expect(stopped).toBe(true);
  expect(notices).toEqual([notice, notice, notice]);
});
it("pins worker identity and model and routes HTTP through source authority without target credentials", async () => {
  const operations: string[] = [];
  const server = NodeHttp.createServer(async (req, res) => {
    expect(req.headers.authorization).toBe("Bearer scoped-source-capability");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(body.requestId).toBe("http-worker");
    expect(body.requestDigest).toBe("immutable-digest");
    operations.push(body.operation);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        body.operation === "infer"
          ? {
              requestJson: JSON.stringify({
                id: "r1",
                output: [
                  {
                    type: "message",
                    id: "m1",
                    role: "assistant",
                    content: [{ type: "output_text", text: "hello" }],
                  },
                  {
                    type: "function_call",
                    id: "f1",
                    call_id: "c1",
                    name: "shell",
                    arguments: '{"command":"pwd"}',
                  },
                ],
                status: "completed",
              }),
            }
          : {},
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  const route = {
    sourceEnvironmentId: "source",
    targetEnvironmentId: "target",
    requestId: "http-worker",
    requestDigest: "immutable-digest",
    capability: "scoped-source-capability",
    port: address.port,
  };
  const pin = {
    targetEnvironmentId: "target",
    requestDigest: "immutable-digest",
    modelId: "gpt-6.1-sol",
  };
  await expect(installWorkerSourceRoute("another-worker", route, pin)).rejects.toThrow();
  await expect(
    installWorkerSourceRoute("http-worker", route, { ...pin, targetEnvironmentId: "foreign" }),
  ).rejects.toThrow();
  const harness = await installWorkerSourceRoute("http-worker", route, pin);
  cleanups.push(harness.revoke);
  const invoke = (model: string, token = harness.apiKey) =>
    fetch(`${harness.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, stream: true }),
    });
  expect((await invoke(pin.modelId, "owner-token")).status).toBe(403);
  expect((await invoke("foreign-model")).status).toBe(502);
  const response = await invoke(pin.modelId);
  const events = (await response.text())
    .split("\n\n")
    .filter(Boolean)
    .map((event) => JSON.parse(event.split("\ndata: ")[1]!));
  expect(
    events.filter((event) => event.type === "response.output_item.done").map((event) => event.item),
  ).toEqual([
    {
      type: "message",
      id: "m1",
      role: "assistant",
      content: [{ type: "output_text", text: "hello" }],
    },
    {
      type: "function_call",
      id: "f1",
      call_id: "c1",
      name: "shell",
      arguments: '{"command":"pwd"}',
    },
  ]);
  expect(events.at(-1).type).toBe("response.completed");
  expect(operations).toEqual(["admit", "infer"]);
  const oversized = await fetch(`${harness.baseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${harness.apiKey}` },
    body: JSON.stringify({ model: pin.modelId, input: "a".repeat(256 * 1024) }),
  });
  expect(oversized.status).toBe(502);
  expect(operations).toEqual(["admit", "infer"]);
  expect(harness.identity.requestDigest).toBe(route.requestDigest);
  expect(await installWorkerSourceRoute("http-worker", route, pin)).toBe(harness);
  expect(operations.at(-1)).toBe("admit");
  await expect(
    installWorkerSourceRoute("http-worker", { ...route, capability: "substituted" }, pin),
  ).rejects.toThrow("substitution");
  await expect(installWorkerSourceRoute("http-worker", { ...route, port: 1 }, pin)).rejects.toThrow(
    "substitution",
  );
  await harness.revoke();
  await expect(installWorkerSourceRoute("http-worker", route, pin)).rejects.toThrow("revocation");
  await expect(harness.admit()).rejects.toThrow("revoked");
  await expect(invoke(pin.modelId)).rejects.toThrow();
});
it("fails closed when source connection disappears", async () => {
  const harness = await installWorkerSourceRoute(
    "lost-worker",
    {
      sourceEnvironmentId: "source",
      targetEnvironmentId: "target",
      requestId: "lost-worker",
      requestDigest: "digest",
      capability: "capability",
      port: 1,
    },
    { targetEnvironmentId: "target", requestDigest: "digest", modelId: "gpt-6.1-sol" },
  );
  cleanups.push(harness.revoke);
  const response = await fetch(`${harness.baseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${harness.apiKey}` },
    body: JSON.stringify({ model: harness.model }),
  });
  expect(response.status).toBe(502);
});
it("runs Claude Messages tool round trips through the same pinned source route", async () => {
  const received: Array<Record<string, unknown>> = [];
  const server = NodeHttp.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(body.requestId).toBe("claude-http-worker");
    expect(body.requestDigest).toBe("claude-digest");
    res.setHeader("content-type", "application/json");
    if (body.operation === "computers")
      return res.end(
        JSON.stringify({
          schemaVersion: 1,
          computers: [
            {
              id: "registered-gpu3",
              label: "gpu3",
              environmentId: "target",
              presentationKind: "ssh",
              harnesses: [{ harness: "claude-code", available: true }],
              profiles: [],
            },
          ],
        }),
      );
    if (body.operation !== "infer") return res.end("{}");
    const request = JSON.parse(body.payload.requestJson);
    received.push(request);
    res.end(
      JSON.stringify({
        requestJson: JSON.stringify({
          id: "message-1",
          type: "message",
          role: "assistant",
          model: request.model,
          content: [
            { type: "thinking", thinking: "Inspect the checkout.", signature: "signed-thinking" },
            { type: "text", text: "Running the check." },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "hostname" } },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  const route = {
    sourceEnvironmentId: "source",
    targetEnvironmentId: "target",
    requestId: "claude-http-worker",
    requestDigest: "claude-digest",
    capability: "scoped-claude-capability",
    port: address.port,
  };
  const pin = {
    targetEnvironmentId: "target",
    requestDigest: route.requestDigest,
    modelId: "gpt-6.1-sol",
    harness: "claude-code" as const,
  };
  const harness = await installWorkerSourceRoute(route.requestId, route, pin);
  cleanups.push(harness.revoke);
  const invoke = (messages: unknown, stream = true, key = harness.apiKey) =>
    fetch(`${harness.baseUrl}/messages`, {
      method: "POST",
      headers: { "x-api-key": key },
      body: JSON.stringify({ model: harness.model, max_tokens: 100, messages, stream }),
    });
  expect((await invoke([], true, "foreign-token")).status).toBe(403);
  expect(
    (
      await fetch(`${harness.baseUrl}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${harness.apiKey}` },
      })
    ).status,
  ).toBe(404);
  const inventory = await fetch(`${harness.baseUrl}/workjet/computers`, {
    headers: { authorization: `Bearer ${harness.apiKey}` },
  });
  expect(inventory.status).toBe(200);
  expect(await inventory.json()).toMatchObject({
    computers: [
      {
        id: "registered-gpu3",
        label: "gpu3",
        environmentId: "target",
        presentationKind: "ssh",
        harnesses: [{ harness: "claude-code", available: true }],
        profiles: [],
      },
    ],
  });
  const response = await invoke([{ role: "user", content: "Check hostname" }]);
  expect(response.status).toBe(200);
  const events = (await response.text())
    .split("\n\n")
    .filter(Boolean)
    .map((entry) => JSON.parse(entry.split("\ndata: ")[1]!));
  expect(events[0].type).toBe("message_start");
  expect(events.find((entry) => entry.delta?.type === "signature_delta").delta.signature).toBe(
    "signed-thinking",
  );
  const tool = events.find((entry) => entry.content_block?.type === "tool_use");
  expect(tool.content_block).toEqual({ type: "tool_use", id: "tool-1", name: "Bash", input: {} });
  expect(events.find((entry) => entry.delta?.type === "input_json_delta").delta.partial_json).toBe(
    JSON.stringify({ command: "hostname" }),
  );
  expect(events.at(-2).delta.stop_reason).toBe("tool_use");
  expect(events.at(-1).type).toBe("message_stop");
  const continuation = [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "hostname" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "gpu3" }] },
  ];
  const next = await invoke(continuation, false);
  expect(await next.json()).toMatchObject({
    content: expect.arrayContaining([expect.objectContaining({ type: "tool_use", id: "tool-1" })]),
  });
  expect(received.map((entry) => entry.stream)).toEqual([false, false]);
  expect(received[1]?.messages).toEqual(continuation);
  await expect(
    installWorkerSourceRoute(route.requestId, route, { ...pin, harness: "codex-cli" }),
  ).rejects.toThrow("substitution");
});
it.effect("admits a source-only catalog and native API-key requests before forwarding unchanged SSE", () => Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  yield* Effect.promise(async () => {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(
      environment.TMPDIR ?? (platform === "darwin" ? "/Volumes/tmp" : NodeOS.tmpdir()),
      "worker-source-native-",
    ),
  );
  cleanups.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  let admitted = true;
  let inferred = 0;
  const server = NodeHttp.createServer(async (req, res) => {
    expect(req.headers.authorization).toBe("Bearer native-source-capability");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!admitted) {
      res.writeHead(403).end();
      return;
    }
    if (body.operation === "infer") {
      expect(body.payload.protocol).toBe("messages");
      const request = JSON.parse(body.payload.requestJson);
      expect(request.model).toBe("gpt-6.1-sol");
      expect(request.stream).toBe(true);
      inferred++;
      const frame = `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `call-${inferred}`, name: "Bash", input: { command: `printf 'PROXY_MATRIX_${String(inferred).padStart(2, "0")}\\n'` } } })}\n\n`;
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ contentType: "text/event-stream", requestJson: frame }));
    } else res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  const route = {
    sourceEnvironmentId: "source",
    targetEnvironmentId: "target",
    requestId: "native-profile-worker",
    requestDigest: "native-profile-digest",
    capability: "native-source-capability",
    port: address.port,
  };
  const pin = {
    targetEnvironmentId: "target",
    requestDigest: route.requestDigest,
    modelId: "gpt-6.1-sol",
    nativeProfile: { harness: "minimax-code" as const, directory },
  };
  const harness = await installWorkerSourceRoute(route.requestId, route, pin);
  cleanups.push(harness.revoke);
  const profile = JSON.parse(
    await NodeFSP.readFile(NodePath.join(directory, "config.yaml"), "utf8"),
  );
  expect(profile.custom_provider["workjet-source"].options.apiKey).toBe(harness.apiKey);
  expect(Object.keys(profile.custom_provider["workjet-source"].models)).toEqual(["gpt-6.1-sol"]);
  if (platform !== "win32")
    expect((await NodeFSP.stat(NodePath.join(directory, "config.yaml"))).mode & 0o077).toBe(0);
  expect(
    (await fetch(harness.baseUrl + "/models", { headers: { "x-api-key": "wrong-key" } })).status,
  ).toBe(403);
  const catalog = await fetch(harness.baseUrl + "/models", {
    headers: { "x-api-key": harness.apiKey },
  });
  expect(await catalog.json()).toEqual({
    object: "list",
    data: [{ id: "gpt-6.1-sol", object: "model", owned_by: "workjet-source" }],
  });
  for (let n = 1; n <= 20; n++) {
    const response = await fetch(harness.baseUrl + "/messages?beta=true", {
      method: "POST",
      headers: { "x-api-key": harness.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ model: harness.model, stream: true }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const frame = JSON.parse((await response.text()).split("\ndata: ")[1]!);
    expect(frame.content_block.id).toBe(`call-${n}`);
    expect(frame.content_block.name).toBe("Bash");
  }
  expect(inferred).toBe(20);
  await expect(
    installWorkerSourceRoute(route.requestId, route, {
      ...pin,
      nativeProfile: { ...pin.nativeProfile, harness: "pi-code" },
    }),
  ).rejects.toThrow("substitution");
  admitted = false;
  expect(
    (await fetch(harness.baseUrl + "/models", { headers: { "x-api-key": harness.apiKey } })).status,
  ).toBe(502);
  });
}));
