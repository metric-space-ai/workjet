// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Real loopback HTTP fixture exercises the external Codex transport boundary.
import { createServer } from "node:http";
import { afterEach, expect, it } from "vite-plus/test";
import { installWorkerSourceRoute } from "./WorkerSourceHarness.ts";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
it("pins worker identity and model and routes HTTP through source authority without target credentials", async () => {
  const operations: string[] = [];
  const server = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe("Bearer scoped-source-capability");
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(body.requestId).toBe("http-worker");
    expect(body.requestDigest).toBe("immutable-digest");
    operations.push(body.operation);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body.operation === "infer" ? { requestJson: JSON.stringify({ id: "r1", output: [
      { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      { type: "function_call", id: "f1", call_id: "c1", name: "shell", arguments: '{"command":"pwd"}' },
    ], status: "completed" }) } : {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no listener");
  const route = { sourceEnvironmentId: "source", targetEnvironmentId: "target", requestId: "http-worker", requestDigest: "immutable-digest", capability: "scoped-source-capability", port: address.port };
  const pin = { targetEnvironmentId: "target", requestDigest: "immutable-digest", modelId: "gpt-6.1-sol" };
  await expect(installWorkerSourceRoute("another-worker", route, pin)).rejects.toThrow();
  await expect(installWorkerSourceRoute("http-worker", route, { ...pin, targetEnvironmentId: "foreign" })).rejects.toThrow();
  const harness = await installWorkerSourceRoute("http-worker", route, pin);
  cleanups.push(harness.revoke);
  const invoke = (model: string, token = harness.apiKey) => fetch(`${harness.baseUrl}/responses`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model, stream: true }),
  });
  expect((await invoke(pin.modelId, "owner-token")).status).toBe(403);
  expect((await invoke("foreign-model")).status).toBe(502);
  const response = await invoke(pin.modelId);
  const events = (await response.text()).split("\n\n").filter(Boolean).map((event) => JSON.parse(event.split("\ndata: ")[1]!));
  expect(events.filter((event) => event.type === "response.output_item.done").map((event) => event.item)).toEqual([
    { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    { type: "function_call", id: "f1", call_id: "c1", name: "shell", arguments: '{"command":"pwd"}' },
  ]);
  expect(events.at(-1).type).toBe("response.completed");
  expect(operations).toEqual(["admit", "infer"]);
  const oversized = await fetch(`${harness.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${harness.apiKey}` }, body: JSON.stringify({ model: pin.modelId, input: "a".repeat(256 * 1024) }) });
  expect(oversized.status).toBe(502);
  expect(operations).toEqual(["admit", "infer"]);
  expect(harness.identity.requestDigest).toBe(route.requestDigest);
  await harness.revoke();
  await expect(harness.admit()).rejects.toThrow("revoked");
  await expect(invoke(pin.modelId)).rejects.toThrow();
});
it("fails closed when source connection disappears", async () => {
  const harness = await installWorkerSourceRoute("lost-worker", {
    sourceEnvironmentId: "source", targetEnvironmentId: "target", requestId: "lost-worker", requestDigest: "digest", capability: "capability", port: 1,
  }, { targetEnvironmentId: "target", requestDigest: "digest", modelId: "gpt-6.1-sol" });
  cleanups.push(harness.revoke);
  const response = await fetch(`${harness.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${harness.apiKey}` }, body: JSON.stringify({ model: harness.model }) });
  expect(response.status).toBe(502);
});
