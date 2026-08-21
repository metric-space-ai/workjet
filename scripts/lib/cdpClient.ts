// @effect-diagnostics globalFetch:off globalTimers:off nodeBuiltinImport:off
// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * A minimal Chrome DevTools Protocol client, extracted so more than one
 * harness can drive an Electron app.
 *
 * ── Why extracted, and why no Playwright ────────────────────────────────────
 * `docs/workjet-remaining-work.md` item 1 (the Code-mode end-to-end driver)
 * was scoped as needing "a browser-driver dependency". It does not: this
 * client already existed and already drove a packaged app, it was simply
 * private to `ctox-packaged-smoke.ts`. Adding Playwright would have brought a
 * second driver, a browser download in CI, and a second way for the two
 * harnesses to disagree about what "the app is up" means.
 *
 * ── The bounds are the substance ────────────────────────────────────────────
 * Everything here talks to a process the harness itself launched, but its
 * OUTPUT is still untrusted: a hung or hostile page must not hang or exhaust
 * the harness. So every message is capped, every request has a deadline, and
 * a socket that closes rejects every in-flight request instead of leaving
 * callers waiting forever.
 */
/** Beyond this a single CDP frame is refused rather than buffered. */
export const MAX_CDP_MESSAGE_BYTES = 1024 * 1024;

/**
 * A CDP error carries a numeric code or nothing usable. The message is built
 * from the METHOD and that code — never from the page's own error text, which
 * is attacker-influenced content on any page the app has navigated to.
 */
export function cdpCommandError(method: string, value: unknown): Error {
  const code =
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).code === "number" &&
    Number.isSafeInteger((value as Record<string, unknown>).code)
      ? ((value as Record<string, unknown>).code as number)
      : undefined;
  return new Error(
    code === undefined ? `CDP ${method} failed` : `CDP ${method} failed (code ${code})`,
  );
}

export class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event: { readonly data: unknown }) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (Buffer.byteLength(data) > MAX_CDP_MESSAGE_BYTES) {
        this.rejectAll(new Error("CDP message is too large"));
        this.close();
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const response = value as Record<string, unknown>;
      if (typeof response.id !== "number") return;
      const waiter = this.pending.get(response.id);
      if (waiter === undefined) return;
      this.pending.delete(response.id);
      if (response.error !== undefined)
        waiter.reject(cdpCommandError("Runtime.evaluate", response.error));
      else waiter.resolve(response.result);
    });
    socket.addEventListener("close", () => this.rejectAll(new Error("CDP connection closed")));
    socket.addEventListener("error", () => this.rejectAll(new Error("CDP connection failed")));
  }
  static async connect(url: string): Promise<CdpClient> {
    if (!/^ws:\/\/127\.0\.0\.1:\d+\//u.test(url))
      throw new Error("CDP target endpoint is not loopback");
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("CDP connection timed out"));
      }, 2_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CDP connection failed"));
        },
        { once: true },
      );
    });
    return new CdpClient(socket);
  }
  async evaluate(expression: string, timeoutMs = 4_000): Promise<unknown> {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeoutMs,
    );
    if (typeof result !== "object" || result === null)
      throw new Error("CDP evaluation returned no result");
    const record = result as Record<string, unknown>;
    if (record.exceptionDetails !== undefined) throw new Error("CDP evaluation failed");
    const remote = record.result;
    if (typeof remote !== "object" || remote === null)
      throw new Error("CDP evaluation returned no value");
    return (remote as Record<string, unknown>).value;
  }
  private send(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP command timed out"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
  close(): void {
    this.socket.close();
  }
}
