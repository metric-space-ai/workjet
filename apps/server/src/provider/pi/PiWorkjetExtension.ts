/** Loaded by native Pi; tokens stay in the child environment and never enter this file. */
export const PI_WORKJET_EXTENSION = String.raw`
export default async function(pi) {
  const endpoint = process.env.WORKJET_PI_MCP_ENDPOINT;
  const authorization = process.env.WORKJET_PI_MCP_AUTHORIZATION;
  if (!endpoint || !authorization) return;
  let sessionId;
  let protocolVersion;
  let requestId = 0;
  async function request(method, params, signal) {
    const id = ++requestId;
    const response = await fetch(endpoint, {
      method: "POST", signal,
      headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}), ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) throw new Error("Workjet MCP " + method + " returned HTTP " + response.status);
    sessionId = response.headers.get("mcp-session-id") || sessionId;
    let reply;
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!reply) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
            if (data) { const message = JSON.parse(data); if (message.id === id) reply = message; }
          }
        }
      } finally { await reader.cancel(); }
    } else reply = await response.json();
    if (!reply) throw new Error("Workjet MCP did not reply to " + method);
    if (reply.error) throw new Error(reply.error.message || "Workjet MCP request failed");
    return reply.result;
  }
  const handshake = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "workjet-pi", version: "1" } }, AbortSignal.timeout(30000));
  protocolVersion = handshake.protocolVersion;
  if (typeof protocolVersion !== "string") throw new Error("Workjet MCP did not negotiate a protocol version.");
  const initialized = await fetch(endpoint, {
    method: "POST", signal: AbortSignal.timeout(30000),
    headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}), ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  if (!initialized.ok) throw new Error("Workjet MCP initialization returned HTTP " + initialized.status);
  const listed = await request("tools/list", {}, AbortSignal.timeout(30000));
  for (const tool of listed.tools) {
    const boxed = tool.inputSchema.type !== "object";
    pi.registerTool({
      name: tool.name, label: tool.title || tool.name, description: tool.description || tool.name,
      parameters: boxed ? { type: "object", properties: { input: tool.inputSchema }, required: ["input"], additionalProperties: false } : tool.inputSchema,
      async execute(toolCallId, args, signal) {
        const result = await request("tools/call", { name: tool.name, arguments: boxed ? args.input : args }, signal);
        if (result.isError) throw new Error(result.content?.filter(part => part.type === "text").map(part => part.text).join("\n") || "Workjet MCP tool failed");
        return { content: result.content || [], details: result.structuredContent || {} };
      },
    });
  }
  pi.on("session_shutdown", async () => {
    if (sessionId) await fetch(endpoint, { method: "DELETE", signal: AbortSignal.timeout(5000), headers: { Authorization: authorization, "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": protocolVersion } }).catch(() => undefined);
  });
}
`;
