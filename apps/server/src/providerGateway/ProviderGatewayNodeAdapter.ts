// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off -- Explicit Node platform boundary injected into the Effect gateway service.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import type {
  WorkjetGatewayModelBinding,
  WorkjetGatewayInferenceProtocol,
  WorkjetGatewayInferenceResult,
} from "@workjet/contracts";
import { discoverKimiConnection } from "./KimiConnection.ts";
import { discoverZaiConnection } from "./ZaiConnection.ts";
import { discoverApiKeyModels } from "./ApiKeyModelConnection.ts";
import { readPublicModelCatalog } from "./LiveProviderCatalog.ts";
import { discoverClaudeModels } from "./ClaudeConnection.ts";

import type {
  GatewayHostProcess,
  GatewayProcessExit,
  ProviderGatewayPlatform,
} from "./ProviderGatewayService.ts";

const readBoundedResponse = async (response: Response, maximumBytes: number): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("oversized");
  if (!response.ok || response.body === null) throw new Error("unavailable");
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        break;
      }
      size += next.value.byteLength;
      if (size > maximumBytes) throw new Error("oversized");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

const withTimeout = async <A>(
  promise: Promise<A>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<A> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          onTimeout();
          reject(new Error("timeout"));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

/** The source alone sends inference to its own gateway. Never returns transport credentials/headers. */
export async function forwardSourceGatewayProtocol(
  endpoint: string,
  selected: WorkjetGatewayModelBinding,
  requestJson: string,
  deadlineMs: number,
  protocol: WorkjetGatewayInferenceProtocol,
  signal?: AbortSignal,
): Promise<WorkjetGatewayInferenceResult> {
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("invalid gateway endpoint");
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new Error("expired");
  const paths = {
    responses: "/v1/responses",
    messages: "/v1/messages",
    "chat-completions": "/v1/chat/completions",
  };
  const response = await fetch(new URL(paths[protocol], url), {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: "Bearer workjet-gateway",
      "content-type": "application/json",
      "X-CTOX-Provider": selected.providerRef.provider,
      "X-CTOX-Account": selected.credentialRef.accountId,
      "X-CTOX-Purpose": "remote-worker",
    },
    body: requestJson,
    signal: AbortSignal.any([
      AbortSignal.timeout(Math.min(120_000, remaining)),
      ...(signal === undefined ? [] : [signal]),
    ]),
  });
  if (response.headers.get("X-CTOX-Account-Selected") !== selected.credentialRef.accountId) {
    await response.body?.cancel();
    throw new Error("exact account unavailable");
  }
  try {
    const body = await readBoundedResponse(response, 1024 * 1024);
    const streaming = JSON.parse(requestJson).stream === true;
    if (streaming) {
      if (!response.headers.get("content-type")?.startsWith("text/event-stream"))
        throw new Error("missing native event stream");
      const frames = body.split(/\r?\n\r?\n/);
      if (frames.pop()?.trim()) throw new Error("incomplete native event stream");
      let completed = false;
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        if (data === "[DONE]") {
          if (protocol === "chat-completions") completed = true;
          continue;
        }
        const event: unknown = JSON.parse(data);
        if (typeof event !== "object" || event === null || Array.isArray(event))
          throw new Error("invalid native event");
        const value = event as Record<string, unknown>;
        if (value.error != null || value.type === "error" || value.type === "response.failed")
          throw new Error("failed native event stream");
        if (
          (protocol === "responses" && value.type === "response.completed") ||
          (protocol === "messages" && value.type === "message_stop")
        )
          completed = true;
      }
      if (!completed) throw new Error("incomplete native event stream");
      return { requestJson: body, contentType: "text/event-stream" };
    }
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const result = parsed as Record<string, unknown>;
    if (
      result.error != null ||
      result.status === "failed" ||
      (protocol === "messages" && (result.type !== "message" || result.role !== "assistant")) ||
      !Array.isArray(
        protocol === "responses"
          ? result.output
          : protocol === "messages"
            ? result.content
            : result.choices,
      )
    )
      throw new Error("invalid response");
    return { requestJson: body, contentType: "application/json" };
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

/** Original Codex relay contract: buffered Responses JSON. */
export async function forwardSourceGatewayResponses(
  endpoint: string,
  selected: WorkjetGatewayModelBinding,
  requestJson: string,
  deadlineMs: number,
  signal?: AbortSignal,
  protocol: "responses" | "messages" = "responses",
): Promise<string> {
  const result = await forwardSourceGatewayProtocol(
    endpoint,
    selected,
    requestJson,
    deadlineMs,
    protocol,
    signal,
  );
  if (result.contentType !== "application/json")
    throw new Error("expected buffered Responses JSON");
  return result.requestJson;
}

export const nodeProviderGatewayPlatform: ProviderGatewayPlatform = {
  publicModelCatalog: readPublicModelCatalog,
  discoverClaudeModels,
  discoverKimiConnection,
  discoverZaiConnection,
  discoverApiKeyModels,
  fingerprint: (value) => NodeCrypto.createHash("sha256").update(value).digest("hex"),
  providerModelCheck: async (endpoint, provider, accountId, modelId, signal) => {
    const response = await fetch(new URL("/v1/responses", endpoint), {
      method: "POST",
      headers: {
        authorization: "Bearer workjet-gateway",
        "content-type": "application/json",
        "X-CTOX-Provider": provider,
        "X-CTOX-Account": accountId,
        "X-CTOX-Purpose": "model-check",
      },
      body: JSON.stringify({
        model: modelId,
        input: [{ role: "user", content: "Hi" }],
        // Keep the xAI answer within its small visible-output limit.
        ...(provider === "xai" ? { instructions: "Reply with Hi only." } : {}),
        // Codex subscriptions reject token caps; checks use non-stored requests.
        // Other providers keep the small output bound; the transport/body bounds apply to all.
        ...(provider === "codex"
          ? { instructions: "Reply with Hi only.", store: false }
          : { max_output_tokens: 8 }),
        stream: false,
      }),
      signal: AbortSignal.any([
        AbortSignal.timeout(15_000),
        ...(signal === undefined ? [] : [signal]),
      ]),
    });
    // Every outcome must acknowledge the exact requested account, including failures.
    if (response.headers.get("X-CTOX-Account-Selected") !== accountId) {
      await response.body?.cancel();
      return {
        status: "unavailable",
        errorClass: null,
        httpStatus: response.status,
        source: "gateway",
        unavailableReason: "exact-account-unavailable",
      };
    }
    const safeErrorClass = response.headers.get("X-CTOX-Error-Class");
    const observedStatus = response.headers.get("X-CTOX-Upstream-Status");
    const upstreamHttpStatus =
      observedStatus !== null && /^[45]\d{2}$/.test(observedStatus) ? Number(observedStatus) : null;
    if (
      !response.ok &&
      upstreamHttpStatus !== null &&
      (safeErrorClass === "auth" ||
        safeErrorClass === "quota-rate-limit" ||
        safeErrorClass === "unknown-model" ||
        safeErrorClass === "network-provider")
    ) {
      await response.body?.cancel();
      return {
        status: "error",
        errorClass: safeErrorClass,
        // Native adapters may wrap a real upstream 401/403/429 in HTTP 502.
        httpStatus: upstreamHttpStatus,
        source: "upstream",
      };
    }
    // Gateway admission errors are not observations from the provider.
    if (!response.ok) {
      await response.body?.cancel();
      return {
        status: "unavailable",
        errorClass: null,
        httpStatus: response.status,
        source: "gateway",
        unavailableReason: "unverified-response",
      };
    }
    let bytes = 0;
    const chunks: Array<Uint8Array> = [];
    const reader = response.body?.getReader();
    try {
      if (reader === undefined) throw new Error("empty");
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 64 * 1024) throw new Error("oversized");
        chunks.push(part.value);
      }
    } finally {
      await reader?.cancel();
    }
    // Inspect only protocol fields in memory, then discard all provider text.
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = null;
    }
    const record =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

    if (
      response.ok &&
      (record.error === undefined || record.error === null) &&
      record.status !== "failed" &&
      Array.isArray(record.output) &&
      record.output.length > 0
    ) {
      return { status: "ok", errorClass: null, httpStatus: response.status, source: "upstream" };
    }
    return {
      status: "unavailable",
      errorClass: null,
      httpStatus: response.status,
      source: "gateway",
      unavailableReason: "unverified-response",
    };
  },
  joinPath: (...parts) => NodePath.join(...parts),
  defaultExecutable: (stateDir) =>
    process.env.WORKJET_PROVIDER_GATEWAY_HOST_EXECUTABLE ??
    (NodeFS.existsSync(NodePath.join(import.meta.dirname, "workjet-provider-gateway-host"))
      ? NodePath.join(import.meta.dirname, "workjet-provider-gateway-host")
      : NodePath.join(stateDir, "provider-gateway-host")),
  byteLength: (value) => (typeof value === "string" ? Buffer.byteLength(value) : value.byteLength),
  chunkText: (value) => (typeof value === "string" ? value : Buffer.from(value).toString("utf8")),
  bytesToHex: (value) => Buffer.from(value).toString("hex"),
  withTimeout,
  readText: async (path, maximumBytes) => {
    const stat = await NodeFSP.stat(path);
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error("invalid file");
    return NodeFSP.readFile(path, "utf8");
  },
  writePrivateText: async (path, content) => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await NodeFSP.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await NodeFSP.chmod(temporary, 0o600);
      await NodeFSP.rename(temporary, path);
      await NodeFSP.chmod(path, 0o600);
    } catch (error) {
      await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  },
  remove: async (path) => NodeFSP.rm(path, { force: true }),
  spawn: (executable, args) => {
    const child = NodeChildProcess.spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {},
      windowsHide: true,
    });
    const exit = new Promise<GatewayProcessExit>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: null, signal: null }));
    });
    if (child.pid === undefined || child.stdout === null || child.stderr === null) {
      // A failed spawn has no pid to signal; Node's kill() on that handle reaches
      // pid 0, i.e. the whole server process group.
      if (child.pid !== undefined) child.kill("SIGKILL");
      throw new Error("spawn failed");
    }
    return {
      pid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      exit,
      kill: (signal) => child.kill(signal),
    } satisfies GatewayHostProcess;
  },
  managementGet: async (endpoint, route, key, maximumBytes) => {
    const response = await fetch(new URL(route, endpoint), {
      method: "GET",
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5_000),
    });
    return JSON.parse(await readBoundedResponse(response, maximumBytes)) as unknown;
  },
  managementRequest: async (endpoint, route, key, method, maximumBytes) => {
    const response = await fetch(new URL(route, endpoint), {
      method,
      headers: { authorization: `Bearer ${key}` },
      // The host's request reader requires a Content-Length on POST.
      ...(method === "POST" ? { body: "" } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("unavailable");
    if (response.body === null) return null;
    const text = await readBoundedResponse(response, maximumBytes);
    return text.trim() === "" ? null : (JSON.parse(text) as unknown);
  },
  signalProcess: (pid, signal) => {
    try {
      return process.kill(pid, signal === "probe" ? 0 : signal);
    } catch {
      return false;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  allocateLoopbackPort: () =>
    new Promise<number>((resolve, reject) => {
      const server = NodeNet.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          if (address !== null && typeof address === "object") resolve(address.port);
          else reject(new Error("no port"));
        });
      });
    }),
};
