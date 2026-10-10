// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off -- Bounded Node loopback adapter for the external Codex process; source identity is schema validated and scoped by its owning Effect service.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import {
  workerSourceNativeProfile,
  type WorkerSourceNativeProfile,
} from "./WorkerSourceNativeProfile.ts";
import { Schema } from "effect";
import { WorkjetComputerInventory, RemoteWorkerHarness } from "@workjet/contracts";

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
const Reply = Schema.Struct({
  requestJson: Schema.String,
  contentType: Schema.optionalKey(Schema.Literals(["application/json", "text/event-stream"])),
});
const nativeProtocols = {
  "/v1/messages": "messages",
  "/v1/chat/completions": "chat-completions",
} as const;
const Response = Schema.Struct({ id: Schema.String, output: Schema.Array(Schema.Unknown) });
const MessagesResponse = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("message"),
  role: Schema.Literal("assistant"),
  model: Schema.String,
  content: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  stop_reason: Schema.NullOr(Schema.String),
  stop_sequence: Schema.optional(Schema.NullOr(Schema.String)),
  usage: Schema.Record(Schema.String, Schema.Unknown),
});

/** Keep the gateway's Messages blocks, tool IDs, signatures and usage intact. */
function writeMessagesStream(res: NodeHttp.ServerResponse, body: unknown): void {
  const message = Schema.decodeUnknownSync(MessagesResponse)(body);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (type: string, data: Record<string, unknown>) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("message_start", {
    message: {
      ...message,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...message.usage, output_tokens: 0 },
    },
  });
  for (const [index, block] of message.content.entries()) {
    const { text, input, thinking, signature, ...metadata } = block;
    event("content_block_start", {
      index,
      content_block:
        block.type === "text"
          ? { ...metadata, text: "" }
          : block.type === "tool_use"
            ? { ...metadata, input: {} }
            : block.type === "thinking"
              ? { ...metadata, thinking: "", signature: "" }
              : block,
    });
    if (block.type === "text" && typeof text === "string")
      event("content_block_delta", { index, delta: { type: "text_delta", text } });
    if (block.type === "tool_use")
      event("content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
      });
    if (block.type === "thinking") {
      if (typeof thinking === "string")
        event("content_block_delta", { index, delta: { type: "thinking_delta", thinking } });
      if (typeof signature === "string")
        event("content_block_delta", { index, delta: { type: "signature_delta", signature } });
    }
    event("content_block_stop", { index });
  }
  event("message_delta", {
    delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence ?? null },
    usage: message.usage,
  });
  event("message_stop", {});
  res.end();
}

export interface WorkerSourceHarness {
  readonly nativeProfile?: WorkerSourceNativeProfile;
  readonly isRevoked: () => boolean;
  readonly identity: Readonly<
    Pick<
      WorkerSourceHarnessRoute,
      "sourceEnvironmentId" | "targetEnvironmentId" | "requestId" | "requestDigest"
    >
  >;
  readonly admit: () => Promise<void>;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly harness: RemoteWorkerHarness;
  readonly revoke: () => Promise<void>;
  readonly retire: () => Promise<void>;
}
const workers = new Map<string, WorkerSourceHarness>();
const installedRoutes = new Map<string, WorkerSourceHarnessRoute>();
export const readWorkerSourceHarness = (threadId: string) => workers.get(threadId);

/** Install before starting the owned worker; revoke with its source connection. */
export async function installWorkerSourceRoute(
  threadId: string,
  input: WorkerSourceHarnessRoute,
  installation: {
    readonly targetEnvironmentId: string;
    readonly requestDigest: string;
    readonly modelId: string;
    readonly harness?: RemoteWorkerHarness;
    readonly nativeProfile?: {
      readonly harness: WorkerSourceNativeProfile["harness"];
      readonly directory: string;
    };
  },
): Promise<WorkerSourceHarness> {
  const route = Object.freeze(Schema.decodeUnknownSync(Route)(input));
  const pin = Object.freeze({
    ...installation,
    harness: Schema.decodeUnknownSync(RemoteWorkerHarness)(
      installation.harness ?? installation.nativeProfile?.harness ?? "codex-cli",
    ),
  });
  if (
    (pin.nativeProfile !== undefined && pin.nativeProfile.harness !== pin.harness) ||
    threadId !== route.requestId ||
    route.targetEnvironmentId !== pin.targetEnvironmentId ||
    route.requestDigest !== pin.requestDigest ||
    !pin.modelId.trim() ||
    !Number.isInteger(route.port) ||
    route.port < 1 ||
    route.port > 65535
  ) {
    throw new Error("Invalid or duplicate worker source route");
  }
  const existing = workers.get(threadId);
  if (existing) {
    const original = installedRoutes.get(threadId);
    if (
      !original ||
      existing.isRevoked() ||
      original.sourceEnvironmentId !== route.sourceEnvironmentId ||
      original.targetEnvironmentId !== route.targetEnvironmentId ||
      original.requestId !== route.requestId ||
      original.requestDigest !== route.requestDigest ||
      original.capability !== route.capability ||
      original.port !== route.port ||
      existing.model !== pin.modelId ||
      existing.harness !== pin.harness ||
      existing.nativeProfile?.harness !== pin.nativeProfile?.harness ||
      existing.nativeProfile?.directory !== pin.nativeProfile?.directory
    )
      throw new Error("Worker source route substitution or revocation");
    await existing.admit();
    return existing;
  }
  const apiKey = NodeCrypto.randomBytes(32).toString("hex");
  const active = new Set<AbortController>();
  let revoked = false;
  let busy = false;
  const source = async (
    operation: "admit" | "infer" | "retire" | "computers",
    payload: unknown,
    signal: AbortSignal,
  ) => {
    const response = await fetch(`http://127.0.0.1:${route.port}/worker-source`, {
      method: "POST",
      signal,
      headers: { authorization: `Bearer ${route.capability}`, "content-type": "application/json" },
      body: JSON.stringify({
        sourceEnvironmentId: route.sourceEnvironmentId,
        targetEnvironmentId: route.targetEnvironmentId,
        requestId: route.requestId,
        requestDigest: route.requestDigest,
        operation,
        payload,
      }),
    });
    if (!response.ok) throw new Error("Source worker authority rejected request");
    return response.json() as Promise<unknown>;
  };
  const server: NodeHttp.Server = NodeHttp.createServer(async (req, res) => {
    const messages = pin.harness === "claude-code";
    const authenticated =
      req.headers.authorization !== undefined
        ? req.headers.authorization === `Bearer ${apiKey}`
        : req.headers["x-api-key"] === apiKey;
    if (revoked || !authenticated) {
      res.writeHead(403).end();
      return;
    }
    const requestPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const legacyMessages = messages && pin.nativeProfile === undefined;
    const protocol =
      requestPath === "/v1/messages" && !legacyMessages
        ? nativeProtocols["/v1/messages"]
        : requestPath === "/v1/chat/completions" && !legacyMessages
          ? nativeProtocols["/v1/chat/completions"]
          : undefined;
    const inventory = req.method === "GET" && requestPath === "/v1/workjet/computers";
    const models = req.method === "GET" && requestPath === "/v1/models";
    if (
      !inventory &&
      !models &&
      (req.method !== "POST" ||
        ((legacyMessages || requestPath !== "/v1/responses") &&
          !(messages && requestPath === "/v1/messages") &&
          protocol === undefined))
    ) {
      res.writeHead(404).end();
      return;
    }
    if (busy) {
      res.writeHead(429).end();
      return;
    }
    busy = true;
    const controller = new AbortController();
    active.add(controller);
    const timeout = setTimeout(() => {
      controller.abort();
      req.destroy();
    }, 120_000);
    const disconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", disconnect);
    try {
      if (inventory || models) {
        await source("admit", {}, controller.signal);
        const response = inventory
          ? Schema.decodeUnknownSync(WorkjetComputerInventory)(
              await source("computers", {}, controller.signal),
            )
          : {
              object: "list",
              data: [{ id: pin.modelId, object: "model", owned_by: "workjet-source" }],
            };
        if (revoked || controller.signal.aborted) throw new Error("Worker route revoked");
        const body = JSON.stringify(response);
        if (Buffer.byteLength(body) > 64 * 1024)
          throw new Error("Worker catalog or inventory too large");
        res
          .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
          .end(body);
        return;
      }
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
      const reply = Schema.decodeUnknownSync(Reply)(
        await source(
          "infer",
          {
            ...(protocol === undefined ? {} : { protocol }),
            requestJson:
              protocol === undefined
                ? JSON.stringify({ ...(json as Record<string, unknown>), stream: false })
                : JSON.stringify(json),
          },
          controller.signal,
        ),
      );
      if (revoked || controller.signal.aborted) throw new Error("Worker route revoked");
      if (protocol !== undefined) {
        const expected = request.stream ? "text/event-stream" : "application/json";
        if (reply.contentType !== expected || Buffer.byteLength(reply.requestJson) > 1024 * 1024)
          throw new Error("Invalid native worker response");
        res
          .writeHead(200, { "content-type": expected, "cache-control": "no-store" })
          .end(reply.requestJson);
        return;
      }
      const result = JSON.parse(reply.requestJson);
      if (messages) {
        const message = Schema.decodeUnknownSync(MessagesResponse)(result);
        if (message.model !== pin.modelId)
          throw new Error("Worker response model differs from source permit");
      } else Schema.decodeUnknownSync(Response)(result);
      if (request.stream && messages) {
        writeMessagesStream(res, result);
      } else if (request.stream) {
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
      clearTimeout(timeout);
      active.delete(controller);
      busy = false;
      res.off("close", disconnect);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Worker loopback did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  let nativeProfile: WorkerSourceNativeProfile | undefined;
  try {
    if (pin.nativeProfile) {
      nativeProfile = workerSourceNativeProfile({
        ...pin.nativeProfile,
        model: pin.modelId,
        baseUrl,
        apiKey,
      });
      await NodeFs.mkdir(nativeProfile.directory, { recursive: true, mode: 0o700 });
      for (const directory of [
        nativeProfile.environment.HOME,
        nativeProfile.environment.XDG_CONFIG_HOME,
        nativeProfile.environment.XDG_DATA_HOME,
        nativeProfile.environment.XDG_CACHE_HOME,
        NodePath.join(nativeProfile.directory, "sessions"),
      ]) {
        await NodeFs.mkdir(directory!, { recursive: true, mode: 0o700 });
      }
      for (const file of nativeProfile.files) {
        const destination = NodePath.join(nativeProfile.directory, file.name);
        await NodeFs.writeFile(destination + ".stage", file.content, { mode: 0o600 });
        await NodeFs.rename(destination + ".stage", destination);
      }
    }
  } catch {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Worker source native profile could not be prepared");
  }
  const harness: WorkerSourceHarness = {
    ...(nativeProfile ? { nativeProfile } : {}),
    isRevoked: () => revoked,
    identity: Object.freeze({
      sourceEnvironmentId: route.sourceEnvironmentId,
      targetEnvironmentId: route.targetEnvironmentId,
      requestId: route.requestId,
      requestDigest: route.requestDigest,
    }),
    admit: async () => {
      if (revoked) throw new Error("Worker route revoked");
      const controller = new AbortController();
      active.add(controller);
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        await source("admit", {}, controller.signal);
      } finally {
        clearTimeout(timeout);
        active.delete(controller);
      }
    },
    baseUrl,
    apiKey,
    model: pin.modelId,
    harness: pin.harness,
    retire: async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await source("retire", {}, controller.signal);
        Schema.decodeUnknownSync(Schema.Struct({ retired: Schema.Literal(true) }))(response);
      } finally {
        clearTimeout(timeout);
        await harness.revoke();
      }
    },
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
  installedRoutes.set(threadId, route);
  return harness;
}
