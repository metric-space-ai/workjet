import * as Schema from "effect/Schema";
import { WorkjetDictationResponse, type WorkjetDictationRequest } from "@workjet/contracts";
import { requestWorkjetProjectControl, type WorkjetProjectControlPort } from "../workjetProjectControl";
import { newCommandId } from "./utils";

/** One short recording routed through the instance's configured speech backend. */
export class ComposerDictationStream {
  private streamId: string | undefined;
  private sequence = 0;
  private pending = 0;
  private writes: Promise<void> = Promise.resolve();
  private failure: unknown;
  private finishing = false;
  private canceled = false;
  constructor(
    private readonly instanceId: string,
    private readonly signal: AbortSignal,
    private readonly port?: WorkjetProjectControlPort,
  ) {}
  private async request(input: WorkjetDictationRequest) {
    this.signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const pending = requestWorkjetProjectControl(this.instanceId, input, this.port);
      // An open receipt arriving after cancellation still owns a stream to close.
      if (input.op === "open") void pending.then((result) => {
        if ((!this.signal.aborted && !this.canceled) || result._tag !== "completed") return;
        const decoded = Schema.decodeUnknownOption(WorkjetDictationResponse)(result.response);
        if (decoded._tag === "Some" && decoded.value.commandId === input.commandId && decoded.value.op === "open") {
          this.streamId = decoded.value.streamId;
          this.cancel();
        }
      }, () => {});
      const result = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Dictation timed out. Retry or check Speech settings.")), 25_000);
          abort = () => reject(new DOMException("Dictation canceled", "AbortError"));
          this.signal.addEventListener("abort", abort, { once: true });
          if (this.signal.aborted) abort();
        }),
      ]);
      this.signal.throwIfAborted();
      if (result._tag !== "completed") throw new Error(result.code === "unsupported"
        ? "Update the instance to enable composer dictation. Open Speech settings."
        : "Dictation could not connect. Check Speech settings and retry.");
      const response = Schema.decodeUnknownSync(WorkjetDictationResponse)(result.response);
      if (response.commandId !== input.commandId || response.op !== input.op ||
        (input.op !== "open" && response.streamId !== input.streamId))
        throw new Error("Dictation response belongs to another recording.");
      if (response.state === "failed" || response.state === "canceled")
        throw new Error("Dictation failed. Check Speech settings and retry.");
      return response;
    } finally {
      clearTimeout(timer);
      if (abort) this.signal.removeEventListener("abort", abort);
    }
  }
  async open() {
    const response = await this.request({ action: "speech.dictation", commandId: newCommandId(), op: "open" });
    if (response.state !== "open") throw new Error("Dictation did not open.");
    this.streamId = response.streamId;
    if (this.canceled || this.signal.aborted) {
      this.cancel();
      throw new DOMException("Dictation canceled", "AbortError");
    }
  }
  write(pcm: Uint8Array): void {
    if (this.canceled || this.finishing || !this.streamId) throw new Error("Dictation is closed.");
    if (this.failure) throw this.failure;
    if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > 3200 || this.pending >= 8)
      throw new Error("Dictation could not keep up with the microphone. Retry this recording.");
    const input: WorkjetDictationRequest = {
      action: "speech.dictation", commandId: newCommandId(), op: "write", streamId: this.streamId,
      sequence: ++this.sequence,
      pcmBase64: btoa(Array.from(pcm, (byte) => String.fromCharCode(byte)).join("")),
    };
    this.pending++;
    this.writes = this.writes.then(async () => {
      if (this.failure) return;
      const response = await this.request(input);
      if (response.state !== "open") throw new Error("Dictation stopped accepting audio.");
    }).catch((error: unknown) => { this.failure ??= error; }).finally(() => { this.pending--; });
  }
  async finish(): Promise<string> {
    if (this.finishing || this.canceled || !this.streamId) throw new Error("Dictation is closed.");
    this.finishing = true;
    await this.writes;
    if (this.failure) throw this.failure;
    let response = await this.request({ action: "speech.dictation", commandId: newCommandId(), op: "finish", streamId: this.streamId });
    const deadline = Date.now() + 15_000;
    while (response.state === "finishing") {
      if (Date.now() > deadline) throw new Error("Dictation did not return text in time.");
      await new Promise<void>((resolve, reject) => {
        const stop = () => { clearTimeout(timer); reject(new DOMException("Dictation canceled", "AbortError")); };
        const timer = setTimeout(() => { this.signal.removeEventListener("abort", stop); resolve(); }, 100);
        this.signal.addEventListener("abort", stop, { once: true });
        if (this.signal.aborted) stop();
      });
      response = await this.request({ action: "speech.dictation", commandId: newCommandId(), op: "read", streamId: this.streamId, afterSequence: 0 });
    }
    if (response.state !== "finished" || response.text === null) throw new Error("Dictation returned no final text.");
    return response.text;
  }
  cancel(): void {
    this.canceled = true;
    if (!this.streamId) return;
    const streamId = this.streamId;
    this.streamId = undefined;
    // Cancellation must work after the UI's AbortSignal has been aborted.
    void requestWorkjetProjectControl(this.instanceId, {
      action: "speech.dictation", commandId: newCommandId(), op: "cancel", streamId,
    }, this.port).catch(() => {});
  }
}
