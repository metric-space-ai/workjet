// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- Real bounded loopback transport integration.
import * as NodeHttp from "node:http";
import {
  EnvironmentId,
  WorkjetConnectionId,
  WorkjetComputerId,
  WorkjetGatewayAccountId,
} from "@workjet/contracts";
import { afterEach, expect, it } from "vite-plus/test";
import { forwardSourceGatewayProtocol } from "./ProviderGatewayNodeAdapter.ts";
import { installWorkerSourceRoute } from "../workjet/WorkerSourceHarness.ts";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of close.splice(0).reverse()) await stop();
});
async function listen(handler: NodeHttp.RequestListener) {
  const server = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  return { endpoint: "http://127.0.0.1:" + address.port + "/", port: address.port };
}
const environmentId = EnvironmentId.make("protocol-source");
const selected = {
  target: {
    connectionId: WorkjetConnectionId.make("connection"),
    instanceId: "instance",
    computerId: WorkjetComputerId.make("computer"),
  },
  credentialRef: { environmentId, accountId: WorkjetGatewayAccountId.make("pinned-account") },
  providerRef: { environmentId, provider: "codex" as const },
  modelRef: { environmentId, provider: "codex" as const, modelId: "gpt-6.1-sol" },
};
it.each(["messages", "chat-completions"] as const)(
  "preserves twenty sequential %s tool/result exchanges over the source channel",
  async (protocol) => {
    let calls = 0;
    const bodies: unknown[] = [];
    const output = (turn: number) =>
      protocol === "messages"
        ? "event: content_block_start\r\ndata: " +
          JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "call-" + turn,
              name: "Bash",
              input: { command: "printf PROXY_" + turn },
            },
          }) +
          '\r\n\r\nevent: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n'
        : "data: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-" + turn,
                      type: "function",
                      function: {
                        name: "exec_command",
                        arguments: JSON.stringify({ cmd: "printf PROXY_" + turn }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n";
    const gateway = await listen(async (req, res) => {
      expect(req.url).toBe(protocol === "messages" ? "/v1/messages" : "/v1/chat/completions");
      expect(req.headers["x-ctox-account"]).toBe("pinned-account");
      expect(req.headers["x-ctox-provider"]).toBe("codex");
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      expect(request.model).toBe(selected.modelRef.modelId);
      expect(request.stream).toBe(true);
      expect(request.messages).toHaveLength(calls * 2 + 1);
      bodies.push(request);
      const result = output(++calls);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "X-CTOX-Account-Selected": "pinned-account",
      });
      // Deliberately split frames and JSON tokens at transport boundaries.
      for (let start = 0; start < result.length; start += 3)
        res.write(result.slice(start, start + 3));
      res.end();
    });
    const operations: string[] = [];
    const source = await listen(async (req, res) => {
      expect(req.headers.authorization).toBe("Bearer source-capability");
      let body = "";
      for await (const chunk of req) body += chunk;
      const operation = JSON.parse(body);
      expect(operation.requestId).toBe("protocol-worker-" + protocol);
      operations.push(operation.operation);
      const reply =
        operation.operation === "infer"
          ? await forwardSourceGatewayProtocol(
              gateway.endpoint,
              selected,
              operation.payload.requestJson,
              Date.now() + 10_000,
              operation.payload.protocol,
            )
          : {};
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
    const requestId = "protocol-worker-" + protocol;
    const harness = await installWorkerSourceRoute(
      requestId,
      {
        sourceEnvironmentId: "source",
        targetEnvironmentId: "target",
        requestId,
        requestDigest: "immutable-digest",
        capability: "source-capability",
        port: source.port,
      },
      {
        targetEnvironmentId: "target",
        requestDigest: "immutable-digest",
        modelId: selected.modelRef.modelId,
      },
    );
    close.push(harness.revoke);
    const history: unknown[] = [{ role: "user", content: "Start" }];
    for (let turn = 1; turn <= 20; turn++) {
      const response = await fetch(
        harness.baseUrl + "/" + (protocol === "messages" ? "messages" : "chat/completions"),
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + harness.apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: harness.model, stream: true, messages: history }),
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(await response.text()).toBe(output(turn));
      history.push(
        protocol === "messages"
          ? {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "call-" + turn,
                  name: "Bash",
                  input: { command: "printf PROXY_" + turn },
                },
              ],
            }
          : {
              role: "assistant",
              tool_calls: [
                {
                  id: "call-" + turn,
                  type: "function",
                  function: {
                    name: "exec_command",
                    arguments: JSON.stringify({ cmd: "printf PROXY_" + turn }),
                  },
                },
              ],
            },
      );
      history.push(
        protocol === "messages"
          ? {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "call-" + turn, content: "PROXY_" + turn },
              ],
            }
          : { role: "tool", tool_call_id: "call-" + turn, content: "PROXY_" + turn },
      );
    }
    expect(calls).toBe(20);
    expect(bodies).toHaveLength(20);
    expect(operations).toEqual(Array.from({ length: 20 }, () => ["admit", "infer"]).flat());
  },
);
it.each([
  'event: content_block_start\ndata: {"type":"content_block_start"}\n\n',
  'event: error\ndata: {"type":"error","error":{"message":"failed"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}',
])("rejects incomplete or failed native streams before publishing: %s", async (body) => {
  const gateway = await listen((_req, res) =>
    res
      .writeHead(200, {
        "content-type": "text/event-stream",
        "X-CTOX-Account-Selected": "pinned-account",
      })
      .end(body),
  );
  await expect(
    forwardSourceGatewayProtocol(
      gateway.endpoint,
      selected,
      JSON.stringify({ model: selected.modelRef.modelId, stream: true, messages: [] }),
      Date.now() + 10_000,
      "messages",
    ),
  ).rejects.toThrow();
});
