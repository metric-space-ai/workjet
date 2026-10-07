// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Real loopback transport fixture.
import * as Http from "node:http";
import { EnvironmentId, WorkjetGatewayAccountId, WorkjetComputerId, WorkjetConnectionId } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { forwardSourceGatewayResponses } from "./ProviderGatewayNodeAdapter.ts";

const environmentId = EnvironmentId.make("source");
const selected = {
  target: { connectionId: WorkjetConnectionId.make("connection"), instanceId: "instance", computerId: WorkjetComputerId.make("computer") },
  credentialRef: { environmentId, accountId: WorkjetGatewayAccountId.make("exact-account") },
  providerRef: { environmentId, provider: "codex" as const },
  modelRef: { environmentId, provider: "codex" as const, modelId: "exact-model" },
};
const requestJson = JSON.stringify({ model: "exact-model", input: "Task", stream: false });

async function withGateway(
  handler: Http.RequestListener,
  run: (endpoint: string) => Promise<void>,
) {
  const server = Http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  try {
    await run(`http://127.0.0.1:${address.port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("source exact-account inference transport", () => {
  it("uses the real loopback Responses route with exact account and provider headers", async () => {
    await withGateway(async (request, response) => {
      expect(request.url).toBe("/v1/responses");
      expect(request.headers.authorization).toBe("Bearer workjet-gateway");
      expect(request.headers["x-ctox-account"]).toBe("exact-account");
      expect(request.headers["x-ctox-provider"]).toBe("codex");
      expect(request.headers["x-ctox-purpose"]).toBe("remote-worker");
      let body = "";
      for await (const chunk of request) body += chunk;
      expect(body).toBe(requestJson);
      response.writeHead(200, { "X-CTOX-Account-Selected": "exact-account", "content-type": "application/json" });
      response.end(JSON.stringify({ output: [{ text: "Result" }] }));
    }, async (endpoint) => {
      const body = await forwardSourceGatewayResponses(endpoint, selected, requestJson, Date.now() + 10000);
      expect(JSON.parse(body)).toEqual({ output: [{ text: "Result" }] });
      expect(body).not.toContain("workjet-gateway");
    });
  });
  it("rejects a gateway retry which selects a different account", async () => {
    await withGateway((_request, response) => {
      response.writeHead(200, { "X-CTOX-Account-Selected": "other-account" });
      response.end(JSON.stringify({ output: [] }));
    }, async (endpoint) => {
      await expect(forwardSourceGatewayResponses(endpoint, selected, requestJson, Date.now() + 10000)).rejects.toThrow("exact account unavailable");
    });
  });
  it("refuses arbitrary destinations and expired permits before opening a connection", async () => {
    await expect(forwardSourceGatewayResponses("https://example.com/", selected, requestJson, Date.now() + 10000)).rejects.toThrow();
    await expect(forwardSourceGatewayResponses("http://127.0.0.1:1/", selected, requestJson, Date.now() - 1)).rejects.toThrow("expired");
  });
});
