// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Node HTTP listener boundary owns socket deadlines and worker capability expiry outside Effect fibers.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

export type WorkerSourceOperation = "admit" | "bindModel" | "infer" | "retire" | "computers";
export interface WorkerSourceIdentity {
  readonly sourceEnvironmentId: string;
  readonly targetEnvironmentId: string;
  readonly requestId: string;
  readonly requestDigest: string;
}
export interface WorkerSourceRoute extends WorkerSourceIdentity {
  /** Worker capability, never a provider credential or an Owner MCP bearer. */
  readonly capability: string;
  readonly port: number;
}
export interface WorkerSourceChannel {
  readonly port: number;
  readonly issue: (
    input: WorkerSourceIdentity & {
      readonly expiresAtMs: number;
      readonly onRetired?: () => void;
      /** Must consult live source authority on every operation. */
      readonly invoke: (
        operation: WorkerSourceOperation,
        payload: unknown,
        signal: AbortSignal,
      ) => Promise<unknown>;
    },
  ) => WorkerSourceRoute;
  readonly revoke: (requestId: string) => void;
  readonly close: () => Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ACTIVE_OPERATIONS = 8;
const OPERATION_TIMEOUT_MS = 120_000;
const operations = new Set<string>([
  "admit",
  "bindModel",
  "infer",
  "retire",
  "retirementAck",
  "computers",
]);

/** Bind only to source loopback. A service-owned registered SSH reverse forward
 * makes this listener reachable on target loopback; never expose the source's
 * general RPC listener or reuse its pairing bearer. Each route closes over one
 * immutable worker and has no endpoint, identity or credential input to invoke.
 * UI teardown cannot close it; the Node service owns close/revoke explicitly. */
export async function openWorkerSourceChannel(): Promise<WorkerSourceChannel> {
  type Session = Parameters<WorkerSourceChannel["issue"]>[0] & {
    readonly capability: string;
    readonly active: Set<AbortController>;
    retirement?: {
      readonly payload: string;
      readonly response: Promise<unknown>;
      readonly expiry: ReturnType<typeof setTimeout>;
    };
  };
  const sessions = new Map<string, Session>();
  const revoked = new Set<string>();
  let closed = false;
  let activeCount = 0;
  const revoke = (requestId: string) => {
    const session = sessions.get(requestId);
    sessions.delete(requestId);
    revoked.add(requestId);
    if (session?.retirement) clearTimeout(session.retirement.expiry);
    for (const controller of session?.active ?? []) controller.abort();
  };
  const server = NodeHttp.createServer((req, res) => {
    const reject = (status: number) => {
      res.writeHead(status);
      res.end();
    };
    if (closed || req.method !== "POST" || req.url !== "/worker-source") return reject(404);
    if (activeCount >= MAX_ACTIVE_OPERATIONS) return reject(429);
    const authorization = req.headers.authorization;
    const session = [...sessions.values()].find((candidate) => {
      const supplied = Buffer.from(authorization ?? "");
      const expected = Buffer.from(`Bearer ${candidate.capability}`);
      return supplied.length === expected.length && NodeCrypto.timingSafeEqual(supplied, expected);
    });
    if (!session || session.expiresAtMs <= Date.now()) {
      if (session) revoke(session.requestId);
      return reject(401);
    }
    const controller = new AbortController();
    session.active.add(controller);
    activeCount++;
    const timer = setTimeout(
      () => {
        controller.abort();
        if (!req.complete) req.destroy();
      },
      Math.min(OPERATION_TIMEOUT_MS, session.expiresAtMs - Date.now()),
    );
    timer.unref();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    void (async () => {
      try {
        let length = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          length += Buffer.byteLength(chunk);
          if (length > MAX_BODY_BYTES) {
            reject(413);
            req.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body === null || typeof body !== "object") return reject(400);
        const value = body as Record<string, unknown>;
        if (
          typeof value.operation !== "string" ||
          !operations.has(value.operation) ||
          value.requestId !== session.requestId ||
          value.requestDigest !== session.requestDigest ||
          value.sourceEnvironmentId !== session.sourceEnvironmentId ||
          value.targetEnvironmentId !== session.targetEnvironmentId
        )
          return reject(403);
        if (
          controller.signal.aborted ||
          sessions.get(session.requestId) !== session ||
          session.expiresAtMs <= Date.now()
        )
          return reject(401);
        const response = await Promise.race([
          (async () => {
            const payload = JSON.stringify(value.payload ?? {});
            const retained = session.retirement;
            if (retained) {
              if (value.operation !== "retire" && value.operation !== "retirementAck")
                throw new Error("retired");
              if (payload !== retained.payload) throw new Error("retirement conflict");
              return retained.response;
            }
            if (value.operation === "retirementAck") throw new Error("not retired");
            if (value.operation === "retire") {
              const response = session.invoke("retire", value.payload, controller.signal);
              const expiry = setTimeout(
                () => {
                  if (sessions.get(session.requestId) !== session) return;
                  revoke(session.requestId);
                  session.onRetired?.();
                },
                Math.max(1, session.expiresAtMs - Date.now()),
              );
              expiry.unref();
              const retirement = { payload, response, expiry };
              session.retirement = retirement;
              try {
                const result = await response;
                for (const other of session.active) if (other !== controller) other.abort();
                return result;
              } catch (error) {
                if (session.retirement === retirement) {
                  clearTimeout(expiry);
                  delete session.retirement;
                }
                throw error;
              }
            }
            if (value.operation !== "admit" && value.operation !== "retire")
              await session.invoke("admit", undefined, controller.signal);
            if (controller.signal.aborted || sessions.get(session.requestId) !== session)
              throw new Error("closed");
            return session.invoke(
              value.operation as WorkerSourceOperation,
              value.payload,
              controller.signal,
            );
          })(),
          new Promise<never>((_, rejectAbort) => {
            controller.signal.addEventListener("abort", () => rejectAbort(new Error("closed")), {
              once: true,
            });
          }),
        ]);
        if (
          controller.signal.aborted ||
          sessions.get(session.requestId) !== session ||
          (session.retirement &&
            value.operation !== "retire" &&
            value.operation !== "retirementAck") ||
          session.expiresAtMs <= Date.now()
        )
          return reject(401);
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-workjet-source-environment": session.sourceEnvironmentId,
          "x-workjet-target-environment": session.targetEnvironmentId,
          "x-workjet-worker-request": session.requestId,
          "x-workjet-worker-digest": session.requestDigest,
        });
        if (value.operation === "retirementAck")
          res.once("finish", () => {
            revoke(session.requestId);
            session.onRetired?.();
          });
        res.end(JSON.stringify(response));
      } catch {
        if (!res.headersSent) reject(controller.signal.aborted ? 503 : 400);
      } finally {
        clearTimeout(timer);
        req.off("aborted", abort);
        res.off("close", abort);
        session.active.delete(controller);
        activeCount--;
      }
    })();
  });
  server.requestTimeout = OPERATION_TIMEOUT_MS;
  server.headersTimeout = 5_000;
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing worker listener");
  const port = address.port;
  let closing: Promise<void> | undefined;
  return {
    port,
    issue(input) {
      if (
        closed ||
        revoked.has(input.requestId) ||
        input.expiresAtMs <= Date.now() ||
        input.sourceEnvironmentId === input.targetEnvironmentId ||
        !/^[a-f0-9]{64}$/.test(input.requestDigest)
      )
        throw new Error("Invalid worker channel");
      const existing = sessions.get(input.requestId);
      if (existing) {
        if (
          existing.requestDigest !== input.requestDigest ||
          existing.sourceEnvironmentId !== input.sourceEnvironmentId ||
          existing.targetEnvironmentId !== input.targetEnvironmentId ||
          existing.expiresAtMs !== input.expiresAtMs
        )
          throw new Error("Worker channel conflict");
        return {
          sourceEnvironmentId: input.sourceEnvironmentId,
          targetEnvironmentId: input.targetEnvironmentId,
          requestId: input.requestId,
          requestDigest: input.requestDigest,
          capability: existing.capability,
          port,
        };
      }
      if (sessions.size + revoked.size >= 128) throw new Error("Worker channel capacity");
      const capability = NodeCrypto.randomBytes(32).toString("base64url");
      sessions.set(input.requestId, { ...input, capability, active: new Set() });
      return {
        sourceEnvironmentId: input.sourceEnvironmentId,
        targetEnvironmentId: input.targetEnvironmentId,
        requestId: input.requestId,
        requestDigest: input.requestDigest,
        capability,
        port,
      };
    },
    revoke,
    close() {
      if (closing) return closing;
      closed = true;
      for (const id of sessions.keys()) revoke(id);
      closing = new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
