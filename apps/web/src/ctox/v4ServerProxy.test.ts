// Renderer half of the C3 proxy: one session per attach, replies carry the current attach id, a
// reconnect drops the old subscriptions, and close silences everything.
import { describe, expect, it } from "vite-plus/test";
import type { CtoxV4ProxyReplyInput } from "@workjet/contracts";
import type { CtoxV4ProxyClientApi } from "@workjet/shared/ctoxV4AppProxy";
import { createCtoxV4RendererSession } from "./v4ServerProxy";

function fakeApi() {
  const listeners = new Set<(rows: unknown[]) => void>();
  let rows: unknown[] = [{ id: "a" }];
  const api = {
    query: () => ({
      get: () => rows,
      subscribe: (listener: (value: unknown[]) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
  } as unknown as CtoxV4ProxyClientApi;
  return {
    api,
    listeners,
    change(next: unknown[]) {
      rows = next;
      for (const listener of listeners) listener(next);
    },
  };
}

describe("C3 renderer session", () => {
  it("answers server requests with the attach id and resets on reconnect", () => {
    const { api, listeners, change } = fakeApi();
    const replies: CtoxV4ProxyReplyInput[] = [];
    const session = createCtoxV4RendererSession(api, (reply) => replies.push(reply));
    const subscribe = {
      type: "request" as const,
      request: { op: "subscribe", subId: "mirror:x", collection: "x", query: {} },
    };
    // Requests before the attach handshake have no session to answer for.
    session.onEvent(subscribe);
    expect(replies).toEqual([]);
    session.onEvent({ type: "attached", attachId: "attach-1" });
    session.onEvent(subscribe);
    expect(replies).toEqual([
      { attachId: "attach-1", reply: { kind: "value", subId: "mirror:x", value: [{ id: "a" }] } },
    ]);
    change([{ id: "a" }, { id: "b" }]);
    expect(replies.at(-1)).toMatchObject({ attachId: "attach-1", reply: { kind: "value" } });
    // Reconnect: the old server session's subscription is gone, the new one answers.
    session.onEvent({ type: "attached", attachId: "attach-2" });
    expect(listeners.size).toBe(0);
    session.onEvent(subscribe);
    expect(replies.at(-1)).toMatchObject({ attachId: "attach-2" });
    session.close();
    expect(listeners.size).toBe(0);
    const count = replies.length;
    change([]);
    session.onEvent(subscribe);
    expect(replies).toHaveLength(count);
  });
});
