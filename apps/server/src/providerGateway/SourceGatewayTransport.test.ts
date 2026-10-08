// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Real loopback transport fixture.
import * as NodeHttp from "node:http";
import {
  EnvironmentId,
  WorkjetGatewayAccountId,
  WorkjetComputerId,
  WorkjetConnectionId,
} from "@workjet/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { forwardSourceGatewayResponses } from "./ProviderGatewayNodeAdapter.ts";

const environmentId = EnvironmentId.make("source");
const selected = {
  target: {
    connectionId: WorkjetConnectionId.make("connection"),
    instanceId: "instance",
    computerId: WorkjetComputerId.make("computer"),
  },
  credentialRef: { environmentId, accountId: WorkjetGatewayAccountId.make("exact-account") },
  providerRef: { environmentId, provider: "codex" as const },
  modelRef: { environmentId, provider: "codex" as const, modelId: "exact-model" },
};
const requestJson = JSON.stringify({ model: "exact-model", input: "Task", stream: false });

async function withGateway(
  handler: NodeHttp.RequestListener,
  run: (endpoint: string) => Promise<void>,
) {
  const server = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  try {
    await run(`http://127.0.0.1:${address.port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("source exact-account inference transport", () => {
  it("uses the real loopback Responses route with exact account and provider headers", async () => {
    await withGateway(
      async (request, response) => {
        expect(request.url).toBe("/v1/responses");
        expect(request.headers.authorization).toBe("Bearer workjet-gateway");
        expect(request.headers["x-ctox-account"]).toBe("exact-account");
        expect(request.headers["x-ctox-provider"]).toBe("codex");
        expect(request.headers["x-ctox-purpose"]).toBe("remote-worker");
        let body = "";
        for await (const chunk of request) body += chunk;
        expect(body).toBe(requestJson);
        response.writeHead(200, {
          "X-CTOX-Account-Selected": "exact-account",
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ output: [{ text: "Result" }] }));
      },
      async (endpoint) => {
        const body = await forwardSourceGatewayResponses(
          endpoint,
          selected,
          requestJson,
          Date.now() + 10000,
        );
        expect(JSON.parse(body)).toEqual({ output: [{ text: "Result" }] });
        expect(body).not.toContain("workjet-gateway");
      },
    );
  });
  it("rejects a gateway retry which selects a different account", async () => {
    await withGateway(
      (_request, response) => {
        response.writeHead(200, { "X-CTOX-Account-Selected": "other-account" });
        response.end(JSON.stringify({ output: [] }));
      },
      async (endpoint) => {
        await expect(
          forwardSourceGatewayResponses(endpoint, selected, requestJson, Date.now() + 10000),
        ).rejects.toThrow("exact account unavailable");
      },
    );
  });
  it("refuses arbitrary destinations and expired permits before opening a connection", async () => {
    await expect(
      forwardSourceGatewayResponses(
        "https://example.com/",
        selected,
        requestJson,
        Date.now() + 10000,
      ),
    ).rejects.toThrow();
    await expect(
      forwardSourceGatewayResponses("http://127.0.0.1:1/", selected, requestJson, Date.now() - 1),
    ).rejects.toThrow("expired");
  });
  it("honors caller cancellation while reading and releases the response reader", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let reading!: () => void;
    const startedReading = new Promise<void>((resolve) => {
      reading = resolve;
    });
    // A real fetch abort rejects its reader; model that behavior without a sleep.
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const abortableBody = new ReadableStream<Uint8Array>({
      start(value) {
        streamController = value;
      },
      pull() {
        reading();
      },
    });
    const abortableResponse = new Response(abortableBody, {
      headers: { "X-CTOX-Account-Selected": "exact-account" },
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      init?.signal?.addEventListener("abort", () =>
        streamController.error(new Error("caller aborted")),
      );
      return abortableResponse;
    });
    try {
      const result = forwardSourceGatewayResponses(
        "http://127.0.0.1:1/",
        selected,
        requestJson,
        Date.now() + 300000,
        controller.signal,
      );
      await startedReading;
      controller.abort();
      await expect(result).rejects.toThrow("caller aborted");
      expect(abortableResponse.body?.locked).toBe(false);
      expect(timeout).toHaveBeenCalledWith(120000);
    } finally {
      fetch.mockRestore();
      timeout.mockRestore();
    }
  });
  it("cancels and unlocks an oversized streamed response", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "X-CTOX-Account-Selected": "exact-account" } },
    );
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      await expect(
        forwardSourceGatewayResponses(
          "http://127.0.0.1:1/",
          selected,
          requestJson,
          Date.now() + 300000,
        ),
      ).rejects.toThrow("oversized");
      expect(cancelled).toBe(true);
      expect(response.body?.locked).toBe(false);
    } finally {
      fetch.mockRestore();
    }
  });
  it.each([503, 200])("rejects an upstream error response with status %s", async (status) => {
    await withGateway(
      (_request, response) => {
        response.writeHead(status, { "X-CTOX-Account-Selected": "exact-account" });
        response.end(JSON.stringify({ error: { message: "upstream failure" } }));
      },
      async (endpoint) => {
        await expect(
          forwardSourceGatewayResponses(endpoint, selected, requestJson, Date.now() + 300000),
        ).rejects.toThrow();
      },
    );
  });
});
