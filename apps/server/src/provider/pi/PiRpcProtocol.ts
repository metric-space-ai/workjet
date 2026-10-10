import * as Schema from "effect/Schema";

export const PiRpcMessage = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  success: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
  messages: Schema.optional(Schema.Array(Schema.Unknown)),
  message: Schema.optional(Schema.Unknown),
  assistantMessageEvent: Schema.optional(
    Schema.Struct({ type: Schema.String, delta: Schema.optional(Schema.String) }),
  ),
  toolCallId: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
});
export type PiRpcMessage = typeof PiRpcMessage.Type;
const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(PiRpcMessage));

/** Native Pi RPC splits only on LF; Unicode separators are valid JSON string contents. */
export class PiRpcFramer {
  private buffer = "";
  push(chunk: string): PiRpcMessage[] {
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) throw new Error("Pi RPC record exceeds 16 MiB.");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines
      .filter((line) => line.trim().length > 0)
      .map((line) => decodeMessage(line.endsWith("\r") ? line.slice(0, -1) : line));
  }
  end(): void {
    if (this.buffer.length > 0) throw new Error("Pi RPC ended with an incomplete JSONL record.");
  }
}
