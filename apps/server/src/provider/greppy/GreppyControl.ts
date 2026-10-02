import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";

import { ProviderAdapterRequestError } from "../Errors.ts";

export interface GreppyRpcSuccess {
  readonly ok: true;
  readonly result: unknown;
}

/**
 * One JSON-RPC call on the serve control socket.
 *
 * A fresh connection is deliberate. `session/subscribe` broadcasts are
 * interleaved with replies on a long-lived socket, and stdout already
 * carries the NDJSON stream, so the control connection only needs the
 * matching response.
 */
export const callGreppyRpc = (input: {
  readonly socketPath: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly id: number;
  readonly timeoutMs?: number;
}): Effect.Effect<GreppyRpcSuccess, ProviderAdapterRequestError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<GreppyRpcSuccess>((resolve, reject) => {
        const socket = NodeNet.createConnection(input.socketPath);
        let buffer = "";
        let settled = false;
        const timer = setTimeout(() => finish(() => reject(new Error("timed out"))), input.timeoutMs ?? 8_000);
        const finish = (settle: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          settle();
        };
        socket.on("error", (error) => finish(() => reject(error)));
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            if (line.length === 0) continue;
            let message: unknown;
            try {
              message = JSON.parse(line);
            } catch {
              continue;
            }
            if (
              message === null ||
              typeof message !== "object" ||
              !("id" in message) ||
              (message as { id?: unknown }).id !== input.id
            ) {
              continue;
            }
            const body = message as { result?: unknown; error?: { message?: unknown } };
            if (body.error !== undefined) {
              const detail =
                typeof body.error.message === "string" && body.error.message.length > 0
                  ? body.error.message
                  : "Greppy rejected the control request.";
              finish(() => reject(new Error(detail)));
              return;
            }
            finish(() => resolve({ ok: true, result: body.result }));
            return;
          }
        });
        socket.on("connect", () => {
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: input.id,
              method: input.method,
              params: input.params,
            })}\n`,
          );
        });
      }),
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: "greppy",
        method: input.method,
        detail: cause instanceof Error ? cause.message : "Greppy control request failed.",
        cause,
      }),
  });
