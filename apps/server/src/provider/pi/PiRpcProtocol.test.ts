import { describe, expect, it } from "vite-plus/test";
import { PiRpcFramer } from "./PiRpcProtocol.ts";

describe("Pi native RPC framing", () => {
  it("accepts fragmented CRLF records without splitting Unicode separators", () => {
    const wire =
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "A\u2028B\u2029C" },
      }) + "\r\n";
    const reader = new PiRpcFramer();
    const messages = [];
    for (const char of wire) messages.push(...reader.push(char));
    expect(messages).toEqual([
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "A\u2028B\u2029C" },
      },
    ]);
    expect(() => reader.end()).not.toThrow();
  });
  it("rejects malformed and incomplete records", () => {
    const reader = new PiRpcFramer();
    expect(() => reader.push("{broken}\n")).toThrow();
    const incomplete = new PiRpcFramer();
    incomplete.push('{"type":"agent_end"}');
    expect(() => incomplete.end()).toThrow(/incomplete/);
  });
});
