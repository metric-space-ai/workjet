import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Schema } from "effect";

const Route = Schema.Struct({
  sourceEnvironmentId: Schema.NonEmptyString,
  targetEnvironmentId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  requestDigest: Schema.NonEmptyString,
  capability: Schema.NonEmptyString,
  port: Schema.Number,
});
export type WorkerSourceHarnessRoute = typeof Route.Type;
const Request = Schema.Struct({ model: Schema.String, stream: Schema.optional(Schema.Boolean) });
const Reply = Schema.Struct({ requestJson: Schema.String });
const Response = Schema.Struct({ id: Schema.String, output: Schema.Array(Schema.Unknown) });
export interface WorkerSourceHarness {
  readonly identity: Readonly<Pick<WorkerSourceHarnessRoute, "sourceEnvironmentId" | "targetEnvironmentId" | "requestId" | "requestDigest">>;
  readonly admit: () => Promise<void>;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly revoke: () => Promise<void>;
}
const workers = new Map<string, WorkerSourceHarness>();
export const readWorkerSourceHarness = (threadId: string) => workers.get(threadId);

/** Install before starting the owned worker; revoke with its source connection. */
export async function installWorkerSourceRoute(
  threadId: string,
  input: WorkerSourceHarnessRoute,
  installation: { readonly targetEnvironmentId: string; readonly requestDigest: string; readonly modelId: string },
): Promise<WorkerSourceHarness> {
  const route = Object.freeze(Schema.decodeUnknownSync(Route)(input));
  const pin = Object.freeze({ ...installation });
  if (threadId !== route.requestId || route.targetEnvironmentId !== pin.targetEnvironmentId || route.requestDigest !== pin.requestDigest || !pin.modelId.trim() || !Number.isInteger(route.port) || route.port < 1 || route.port > 65535 || workers.has(threadId)) {
    throw new Error("Invalid or duplicate worker source route");
  }
  const apiKey = randomBytes(32).toString("hex");
  const active = new Set<AbortController>();
  let revoked = false;
  let busy = false;
  const source = async (operation: "admit" | "infer", payload: unknown, signal: AbortSignal) => {
    const response = await fetch(`http://127.0.0.1:${route.port}/worker-source`, {
      method: "POST", signal,
      headers: { authorization: `Bearer ${route.capability}`, "content-type": "application/json" },
      body: JSON.stringify({
        sourceEnvironmentId: route.sourceEnvironmentId, targetEnvironmentId: route.targetEnvironmentId,
        requestId: route.requestId, requestDigest: route.requestDigest, operation, payload,
      }),
    });
    if (!response.ok) throw new Error("Source worker authority rejected request");
    return response.json() as Promise<unknown>;
  };
  const server: Server = createServer(async (req, res) => {
    if (revoked || req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(403).end(); return;
    }
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.writeHead(404).end(); return;
    }
    if (busy) { res.writeHead(429).end(); return; }
    busy = true;
    const controller = new AbortController();
    active.add(controller);
    const timeout = setTimeout(() => { controller.abort(); req.destroy(); }, 120_000);
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", disconnect);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 256 * 1024) throw new Error("Worker request too large");
        chunks.push(Buffer.from(chunk));
      }
      const json: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const request = Schema.decodeUnknownSync(Request)(json);
      if (request.model !== pin.modelId) throw new Error("Worker model differs from source permit");
      await source("admit", {}, controller.signal);
      const reply = Schema.decodeUnknownSync(Reply)(await source("infer", {
        requestJson: JSON.stringify({ ...(json as Record<string, unknown>), stream: false }),
      }, controller.signal));
      const result = Schema.decodeUnknownSync(Response)(JSON.parse(reply.requestJson));
      if (revoked || controller.signal.aborted) throw new Error("Worker route revoked");
      if (request.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const event = (type: string, data: Record<string, unknown>) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event("response.created", { response: { ...result, output: [], status: "in_progress" } });
        for (const [output_index, item] of result.output.entries()) {
          event("response.output_item.added", { output_index, item });
          event("response.output_item.done", { output_index, item });
        }
        event("response.completed", { response: JSON.parse(reply.requestJson) });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(reply.requestJson);
      }
    } catch {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Worker source authority unavailable" } }));
    } finally {
      clearTimeout(timeout); active.delete(controller); busy = false;
      res.off("close", disconnect);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Worker loopback did not bind");
  const harness: WorkerSourceHarness = {
    identity: Object.freeze({ sourceEnvironmentId: route.sourceEnvironmentId, targetEnvironmentId: route.targetEnvironmentId, requestId: route.requestId, requestDigest: route.requestDigest }),
    admit: async () => {
      if (revoked) throw new Error("Worker route revoked");
      const controller = new AbortController();
      active.add(controller);
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try { await source("admit", {}, controller.signal); }
      finally { clearTimeout(timeout); active.delete(controller); }
    },
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey, model: pin.modelId,
    revoke: async () => {
      revoked = true;
      for (const controller of active) controller.abort();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      // Keep the revoked tombstone: restart must fail closed, never use target auth.
    },
  };
  workers.set(threadId, harness);
  return harness;
}
