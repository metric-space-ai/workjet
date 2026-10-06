// @effect-diagnostics nodeBuiltinImport:off
/** Project JSONL before materializing strings: tool results can be gigabytes long. */
const scalarPath = /^(?:type|timestamp|cwd|isSidechain|aiTitle|title|customTitle|sessionId|payload\.(?:type|role|cwd|id|model|timestamp|parent_thread_id|agent_path|title|thread_name|channel|content)|payload\.git\.repository_url|message\.(?:role|model|content)|(?:payload|message)\.content\.\d+\.(?:type|text))$/u;
const containerPath = /^(?:payload|payload\.git|message|(?:payload|message)\.content(?:\.\d+)?)$/u;
const TEXT_LIMIT = 200_000;
const RAW_TEXT_LIMIT = TEXT_LIMIT * 6;

type Frame = {
  path: string;
  object: boolean;
  value: Record<string, unknown> | unknown[] | undefined;
  state: "key" | "colon" | "value" | "comma";
  key: string;
  index: number;
};

/** Bounded lexer; only transcript metadata and visible content fields survive. */
export class TranscriptRecordProjector {
  private frames: Frame[] = [];
  private root: unknown;
  private invalid = false;
  private token: "string" | "primitive" | undefined;
  private keyToken = false;
  private escaped = false;
  private retained = false;
  private raw = "";
  private clipped = false;
  private textBudget = RAW_TEXT_LIMIT;

  private path(): string {
    const parent = this.frames.at(-1);
    return parent ? [parent.path, parent.object ? parent.key : String(parent.index)].filter(Boolean).join(".") : "";
  }

  private assign(value: unknown): void {
    const parent = this.frames.at(-1);
    if (!parent) {
      if (this.root !== undefined) this.invalid = true;
      this.root = value;
      return;
    }
    if (parent.state !== "value") this.invalid = true;
    if (parent.value && value !== undefined) {
      if (Array.isArray(parent.value)) parent.value.push(value);
      else if (parent.key !== "__proto__") parent.value[parent.key] = value;
    }
    parent.index += 1;
    parent.state = "comma";
  }

  private append(text: string): void {
    if (!this.retained) return;
    const content = /(?:^|\.)content(?:\.|$)/u.test(this.path());
    const limit = this.keyToken ? 512 : content ? this.textBudget : 24_576;
    const remaining = Math.max(0, limit - this.raw.length);
    this.raw += text.slice(0, remaining);
    if (text.length > remaining) this.clipped = true;
  }

  private finishString(): void {
    let value: string | undefined;
    if (this.retained) {
      // A clipped escape may straddle the boundary. Drop only that incomplete escape.
      let raw = this.raw;
      for (let trim = 0; trim <= (this.clipped ? 6 : 0); trim += 1) {
        try {
          value = JSON.parse('"' + raw + '"') as string;
          break;
        } catch {
          raw = raw.slice(0, -1);
        }
      }
      if (value === undefined) this.invalid = true;
      if (!this.keyToken && /(?:^|\.)content(?:\.|$)/u.test(this.path())) {
        this.textBudget -= this.raw.length;
        if (value && (this.clipped || value.length > TEXT_LIMIT))
          value = value.slice(0, TEXT_LIMIT - 25) + "\n[message text truncated]";
      }
    }
    if (this.keyToken) {
      const parent = this.frames.at(-1);
      if (!parent?.object || parent.state !== "key") this.invalid = true;
      else { parent.key = value ?? ""; parent.state = "colon"; }
    } else this.assign(value);
    this.token = undefined;
    this.raw = "";
  }

  private finishPrimitive(): void {
    let value: unknown;
    try { value = JSON.parse(this.raw); } catch { this.invalid = true; }
    this.assign(this.retained ? value : undefined);
    this.token = undefined;
    this.raw = "";
  }

  private finishRecord(): string | undefined {
    if (this.token === "primitive") this.finishPrimitive();
    const record = !this.invalid && !this.token && this.frames.length === 0 && this.root && typeof this.root === "object"
      ? JSON.stringify(this.root) : undefined;
    this.frames = []; this.root = undefined; this.invalid = false;
    this.token = undefined; this.raw = ""; this.escaped = false;
    this.textBudget = RAW_TEXT_LIMIT;
    return record;
  }

  *push(chunk: string): Generator<string> {
    let offset = 0;
    const special = /["\\\r\n]/gu;
    while (offset < chunk.length) {
      const char = chunk[offset]!;
      if (char === "\n") {
        const record = this.finishRecord();
        if (record) yield record;
        offset += 1; continue;
      }
      if (this.invalid) {
        const end = chunk.indexOf("\n", offset);
        offset = end < 0 ? chunk.length : end; continue;
      }
      if (this.token === "string") {
        if (this.escaped) { this.append(char); this.escaped = false; offset += 1; continue; }
        special.lastIndex = offset;
        const match = special.exec(chunk);
        const end = match?.index ?? chunk.length;
        this.append(chunk.slice(offset, end)); offset = end;
        if (!match) continue;
        if (chunk[offset] === '"') { this.finishString(); offset += 1; }
        else if (chunk[offset] === "\\") { this.append("\\"); this.escaped = true; offset += 1; }
        else this.invalid = true;
        continue;
      }
      if (this.token === "primitive") {
        if (/[,}\]\s]/u.test(char)) this.finishPrimitive();
        else { if (this.raw.length < 128) this.raw += char; else this.invalid = true; offset += 1; continue; }
      }
      const parent = this.frames.at(-1);
      if (/\s/u.test(char)) { offset += 1; continue; }
      if (char === '"') {
        this.token = "string"; this.keyToken = parent?.object === true && parent.state === "key";
        if (!this.keyToken && parent && parent.state !== "value") this.invalid = true;
        this.retained = this.keyToken || scalarPath.test(this.path());
        this.clipped = false; this.raw = "";
      } else if (char === "{" || char === "[") {
        if (parent && parent.state !== "value") this.invalid = true;
        const path = this.path();
        const object = char === "{";
        this.frames.push({ path, object, value: (!parent || containerPath.test(path)) ? (object ? Object.create(null) as Record<string, unknown> : []) : undefined,
          state: object ? "key" : "value", key: "", index: 0 });
        if (this.frames.length > 128) this.invalid = true;
      } else if (char === "}" || char === "]") {
        const frame = this.frames.pop();
        if (!frame || frame.object !== (char === "}") || !["key", "value", "comma"].includes(frame.state)) this.invalid = true;
        else this.assign(frame.value);
      } else if (char === ":") {
        if (!parent?.object || parent.state !== "colon") this.invalid = true;
        else parent.state = "value";
      } else if (char === ",") {
        if (!parent || parent.state !== "comma") this.invalid = true;
        else parent.state = parent.object ? "key" : "value";
      } else {
        this.token = "primitive"; this.raw = char; this.retained = scalarPath.test(this.path());
      }
      offset += 1;
    }
  }

  finish(): string | undefined { return this.finishRecord(); }
}

export async function* projectTranscriptRecords(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  const projector = new TranscriptRecordProjector();
  for await (const chunk of chunks) yield* projector.push(chunk);
  const last = projector.finish();
  if (last) yield last;
}
