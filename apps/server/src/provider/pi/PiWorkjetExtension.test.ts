import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { PI_WORKJET_EXTENSION } from "./PiWorkjetExtension.ts";

interface NativeTool {
  name: string;
  parameters: unknown;
  execute: (
    id: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: unknown; details: unknown }>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Pi Workjet MCP extension", () => {
  it("registers the actual MCP schema and forwards twenty correlated calls across fragmented SSE", async () => {
    vi.stubEnv("WORKJET_PI_MCP_ENDPOINT", "http://127.0.0.1:9000/mcp");
    vi.stubEnv("WORKJET_PI_MCP_AUTHORIZATION", "Bearer fixture-token");
    const registered: NativeTool[] = [];
    const calls: unknown[] = [];
    let cancelled = 0;
    const schema = {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    };
    vi.stubGlobal("fetch", async (_url: string, input: RequestInit) => {
      expect(new Headers(input.headers).get("Authorization")).toBe("Bearer fixture-token");
      if (input.method === "DELETE") {
        expect(new Headers(input.headers).get("MCP-Protocol-Version")).toBe("2025-03-26");
        return new Response(null, { status: 204 });
      }
      const message = JSON.parse(String(input.body));
      if (message.method !== "initialize")
        expect(new Headers(input.headers).get("MCP-Protocol-Version")).toBe("2025-03-26");
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (message.method === "initialize")
        return Response.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "fixture", version: "1" },
            },
          },
          { headers: { "Mcp-Session-Id": "fixture-session" } },
        );
      expect(new Headers(input.headers).get("Mcp-Session-Id")).toBe("fixture-session");
      if (message.method === "tools/list")
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "workjet_fixture_echo",
                description: "Echo the command",
                inputSchema: schema,
              },
            ],
          },
        });
      expect(message.method).toBe("tools/call");
      calls.push(message.params);
      const wire = `event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: message.params.arguments.command }], structuredContent: { ok: true } } })}\r\n\r\n`;
      const bytes = new TextEncoder().encode(wire);
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 3)
              controller.enqueue(bytes.slice(offset, offset + 3));
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const loaded = await import(
      /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(PI_WORKJET_EXTENSION)}`
    );
    await loaded.default({
      registerTool: (tool: NativeTool) => registered.push(tool),
      on: () => undefined,
    });
    expect(registered[0]?.parameters).toEqual(schema);
    const tool = registered[0]!;
    for (let n = 1; n <= 20; n++)
      expect(await tool.execute(String(n), { command: `result-${n}` })).toEqual({
        content: [{ type: "text", text: `result-${n}` }],
        details: { ok: true },
      });
    expect(calls).toHaveLength(20);
    expect(cancelled).toBe(20);
  });
  it("fails initialization when the per-thread MCP authorization is rejected", async () => {
    vi.stubEnv("WORKJET_PI_MCP_ENDPOINT", "http://127.0.0.1:9000/mcp");
    vi.stubEnv("WORKJET_PI_MCP_AUTHORIZATION", "Bearer fixture-token");
    vi.stubGlobal("fetch", async () => new Response(null, { status: 401 }));
    const loaded = await import(
      /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(PI_WORKJET_EXTENSION)}`
    );
    await expect(
      loaded.default({ registerTool: () => undefined, on: () => undefined }),
    ).rejects.toThrow("HTTP 401");
  });
});
