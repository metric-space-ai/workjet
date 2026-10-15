import { randomUUID } from "./utils";
import {
  isWorkjetJourFixeSpeechReceiptForRequest,
  type ProjectId,
  type WorkjetJourFixeSpeechRequest,
  type WorkjetJourFixeSpeechResponse,
} from "@workjet/contracts";
import {
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "../workjetProjectControl";
import type { JourFixeSpeechScope } from "./jourFixeSpeech";

const privateReceipts = new WeakSet<object>();
const receiptBrand: unique symbol = Symbol("ctox meeting final");
export interface JourFixePrivateFinalReceipt {
  readonly [receiptBrand]: true;
  readonly scope: JourFixeSpeechScope;
  readonly streamId: string;
  readonly meetingRevision: number;
}
/** Not deserializable or a permission: only this consumer can retain a native final handle. */
class FinalReceipt implements JourFixePrivateFinalReceipt {
  readonly [receiptBrand] = true as const;
  readonly #handle: string;
  constructor(
    readonly scope: JourFixeSpeechScope,
    readonly streamId: string,
    readonly meetingRevision: number,
    handle: string,
  ) {
    this.#handle = handle;
    privateReceipts.add(this);
    Object.freeze(this);
  }
  toJSON(): never {
    // Never turn the private native receipt into a browser-supplied speech proof.
    void this.#handle;
    throw new Error("CTOX speech final receipts are private.");
  }
}
export function isJourFixePrivateFinalReceipt(
  value: unknown,
): value is JourFixePrivateFinalReceipt {
  return typeof value === "object" && value !== null && privateReceipts.has(value);
}
export type JourFixeGatewaySpeechOptions = {
  readonly scope: JourFixeSpeechScope;
  readonly signal: AbortSignal;
  /** Gateway Partial.text is a delta; Main accumulates it into the UI snapshot. */
  readonly onPartial: (event: { streamId: string; sequence: number; text: string }) => void;
  readonly onError?: (error: Error) => void;
  /** Browser can supply its existing Shell project-control port; desktop uses preload. */
  readonly port?: WorkjetProjectControlPort;
};
const aborted = () => new DOMException("Speech scope canceled.", "AbortError");
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(aborted());
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(aborted());
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}
async function request(
  options: JourFixeGatewaySpeechOptions,
  operation: WorkjetJourFixeSpeechRequest,
): Promise<WorkjetJourFixeSpeechResponse> {
  const result = await requestWorkjetProjectControl(
    options.scope.instanceId,
    operation,
    options.port,
  );
  if (result._tag !== "completed") throw new Error(`Speech transport unavailable: ${result.code}`);
  if (
    !isWorkjetJourFixeSpeechReceiptForRequest(operation, result.response) ||
    result.response.action !== "project.jour_fixe.speech"
  )
    throw new Error("Speech transport returned another scope or stream.");
  return result.response;
}

/** One 16 kHz mono PCM16LE sentence, with bounded queued frames and no account fallback. */
export class JourFixeGatewaySpeechStream {
  readonly scope: JourFixeSpeechScope;
  private readonly controller = new AbortController();
  private readonly started = Date.now();
  private pending = 0;
  private sequence = 0;
  private cursor = 0;
  private chain: Promise<void> = Promise.resolve();
  private finishPromise: Promise<JourFixePrivateFinalReceipt> | undefined;
  private terminal: JourFixePrivateFinalReceipt | undefined;
  private failure: Error | undefined;
  private canceled = false;
  private finishing = false;
  private readonly detach: () => void;
  private readonly polling: Promise<void>;
  private constructor(
    readonly streamId: string,
    private readonly options: JourFixeGatewaySpeechOptions,
  ) {
    this.scope = Object.freeze({ ...options.scope });
    const stop = () => {
      void this.cancel().catch(() => {});
    };
    options.signal.addEventListener("abort", stop, { once: true });
    this.detach = () => options.signal.removeEventListener("abort", stop);
    this.polling = this.poll().catch((error: unknown) => {
      if (this.canceled) return;
      this.fail(error);
    });
  }
  static async open(options: JourFixeGatewaySpeechOptions): Promise<JourFixeGatewaySpeechStream> {
    if (options.signal.aborted) throw aborted();
    const frozen = { ...options, scope: Object.freeze({ ...options.scope }) };
    const response = await request(frozen, {
      action: "project.jour_fixe.speech",
      projectId: frozen.scope.projectId as ProjectId,
      meetingId: frozen.scope.meetingId,
      deckRevision: frozen.scope.deckRevision,
      op: "open",
      requestId: randomUUID(),
    });
    if (response.state !== "open") throw new Error("The CTOX speech stream did not open.");
    const stream = new JourFixeGatewaySpeechStream(response.streamId, frozen);
    if (options.signal.aborted) {
      await stream.cancel();
      throw aborted();
    }
    return stream;
  }
  private fields() {
    return {
      action: "project.jour_fixe.speech" as const,
      projectId: this.scope.projectId as ProjectId,
      meetingId: this.scope.meetingId,
      deckRevision: this.scope.deckRevision,
      streamId: this.streamId,
    };
  }
  private assertOpen() {
    if (this.canceled || this.options.signal.aborted) throw aborted();
    if (this.failure) throw this.failure;
    if (Date.now() - this.started > 40_000)
      throw new Error("Speech sentence exceeded its deadline.");
  }
  private fail(reason: unknown) {
    const first = this.failure === undefined;
    this.failure ??= reason instanceof Error ? reason : new Error("Speech transport failed.");
    try {
      if (first) this.options.onError?.(this.failure);
    } catch {
      // A UI notification cannot keep a failed native capture alive.
    } finally {
      void this.cancel().catch(() => {});
    }
  }
  private ingest(response: WorkjetJourFixeSpeechResponse) {
    this.assertOpen();
    for (const event of response.events) {
      if (event.sequence <= this.cursor) continue; // a retried page is not another delta
      if (event.sequence !== this.cursor + 1) throw new Error("Speech partial sequence was lost.");
      this.cursor = event.sequence;
      this.options.onPartial({
        streamId: this.streamId,
        sequence: event.producerSequence,
        text: event.text,
      });
    }
    if (response.state === "failed") throw new Error(`Speech failed: ${response.error}`);
    if (response.state === "canceled") throw aborted();
    if (response.state === "committed") {
      if (!this.finishing || !response.receipt) throw new Error("Unexpected CTOX speech final.");
      this.terminal ??= new FinalReceipt(
        this.scope,
        this.streamId,
        response.receipt.meetingRevision,
        response.receipt.handle,
      );
      this.detach();
    }
  }
  private async poll() {
    while (!this.canceled && !this.terminal) {
      this.assertOpen();
      const response = await request(this.options, {
        ...this.fields(),
        op: "read",
        afterSequence: this.cursor,
      });
      if (this.canceled) return; // exact room closed during the awaited call
      this.ingest(response);
      if (!this.terminal) await pause(100, this.controller.signal);
    }
  }
  write(pcm: Uint8Array): Promise<void> {
    try {
      this.assertOpen();
      if (this.finishing) throw new Error("Speech sentence has already ended.");
      if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > 3200)
        throw new Error("Write mono PCM16LE, 16 kHz, at most 100 ms.");
      if (this.pending >= 8) throw new Error("Speech capture backpressure; stop this sentence.");
    } catch (error) {
      this.fail(error);
      return Promise.reject(error);
    }
    const encoded = btoa(Array.from(pcm, (byte) => String.fromCharCode(byte)).join(""));
    this.pending++;
    const sequence = ++this.sequence;
    const write = this.chain.then(async () => {
      this.assertOpen();
      const response = await request(this.options, {
        ...this.fields(),
        op: "write",
        sequence,
        pcmBase64: encoded,
      });
      this.assertOpen();
      if (response.state !== "open") throw new Error("The CTOX speech write was not accepted.");
    });
    this.chain = write.catch((error) => {
      this.fail(error);
    });
    return write.finally(() => {
      this.pending--;
    });
  }
  finish(): Promise<JourFixePrivateFinalReceipt> {
    if (this.finishPromise) return this.finishPromise;
    this.finishing = true;
    this.finishPromise = (async () => {
      this.assertOpen();
      await this.chain;
      this.assertOpen();
      const response = await request(this.options, { ...this.fields(), op: "finish" });
      this.ingest(response);
      const deadline = Date.now() + 16_000;
      while (!this.terminal) {
        this.assertOpen();
        if (Date.now() > deadline) throw new Error("The CTOX speech final was not confirmed.");
        await pause(20, this.controller.signal);
      }
      await this.polling;
      return this.terminal;
    })().catch((error) => {
      this.fail(error);
      throw error;
    });
    return this.finishPromise;
  }
  async cancel(): Promise<void> {
    if (this.canceled) return;
    this.canceled = true;
    this.detach();
    this.controller.abort();
    // UI closes immediately. Native drops the exact owned stream; a commit that
    // already won the native fence remains durable. Never append pending text.
    await request(this.options, { ...this.fields(), op: "cancel" });
  }
}

export const openJourFixeGatewaySpeech = JourFixeGatewaySpeechStream.open;
