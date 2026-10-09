// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Real loopback HTTP fixture exercises the external Codex transport boundary.
import * as NodeHttp from "node:http";
import { afterEach, expect, it } from "vite-plus/test";
import { installWorkerSourceRoute } from "./WorkerSourceHarness.ts";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
    if (body.operation === "computers") return res.end(JSON.stringify({
      schemaVersion: 1, computers: [{
        id: "registered-gpu3", label: "gpu3", environmentId: "target",
        presentationKind: "ssh", harnesses: [{ harness: "claude-code", available: true }], profiles: [],
      }],
    }));
    if (body.operation !== "infer") return res.end("{}");
    const request = JSON.parse(body.payload.requestJson);
    received.push(request);
    res.end(JSON.stringify({ requestJson: JSON.stringify({
      id: "message-1", type: "message", role: "assistant", model: request.model,
      content: [
        { type: "thinking", thinking: "Inspect the checkout.", signature: "signed-thinking" },
        { type: "text", text: "Running the check." },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "hostname" } },
      ],
      stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 },
    }) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  const route = {
    sourceEnvironmentId: "source", targetEnvironmentId: "target",
    requestId: "claude-http-worker", requestDigest: "claude-digest",
    capability: "scoped-claude-capability", port: address.port,
  };
  const pin = {
    targetEnvironmentId: "target", requestDigest: route.requestDigest,
    modelId: "gpt-6.1-sol", harness: "claude-code" as const,
  };
  const harness = await installWorkerSourceRoute(route.requestId, route, pin);
  cleanups.push(harness.revoke);
  const invoke = (messages: unknown, stream = true, key = harness.apiKey) => fetch(
    `${harness.baseUrl}/messages`, {
      method: "POST", headers: { "x-api-key": key },
      body: JSON.stringify({ model: harness.model, max_tokens: 100, messages, stream }),
    },
  );
  expect((await invoke([], true, "foreign-token")).status).toBe(403);
  expect((await fetch(`${harness.baseUrl}/responses`, {
    method: "POST", headers: { authorization: `Bearer ${harness.apiKey}` },
  })).status).toBe(404);
  const inventory = await fetch(`${harness.baseUrl}/workjet/computers`, {
    headers: { authorization: `Bearer ${harness.apiKey}` },
  });
  expect(inventory.status).toBe(200);
  expect((await inventory.json()).computers[0]).toEqual({
    id: "registered-gpu3", label: "gpu3", environmentId: "target", presentationKind: "ssh",
    harnesses: [{ harness: "claude-code", available: true }], profiles: [],
  });
  const response = await invoke([{ role: "user", content: "Check hostname" }]);
  expect(response.status).toBe(200);
  const events = (await response.text()).split("\n\n").filter(Boolean)
    .map((entry) => JSON.parse(entry.split("\ndata: ")[1]!));
  expect(events[0].type).toBe("message_start");
  expect(events.find((entry) => entry.delta?.type === "signature_delta").delta.signature).toBe("signed-thinking");
  const tool = events.find((entry) => entry.content_block?.type === "tool_use");
  expect(tool.content_block).toEqual({ type: "tool_use", id: "tool-1", name: "Bash", input: {} });
  expect(events.find((entry) => entry.delta?.type === "input_json_delta").delta.partial_json)
    .toBe(JSON.stringify({ command: "hostname" }));
  expect(events.at(-2).delta.stop_reason).toBe("tool_use");
  expect(events.at(-1).type).toBe("message_stop");
  const continuation = [
    { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "hostname" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "gpu3" }] },
  ];
  const next = await invoke(continuation, false);
  expect((await next.json()).content[2].id).toBe("tool-1");
  expect(received.map((entry) => entry.stream)).toEqual([false, false]);
  expect(received[1]?.messages).toEqual(continuation);
  await expect(installWorkerSourceRoute(route.requestId, route, { ...pin, harness: "codex-cli" }))
    .rejects.toThrow("substitution");
});
