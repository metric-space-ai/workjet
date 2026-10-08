import { describe, expect, it } from "vite-plus/test";
import { JourFixeAudioDrain, JourFixePcmFramer, JourFixeUtteranceSegmenter } from "./jourFixePcm";

function frame(value: number) {
  return new JourFixePcmFramer(16_000).push(new Float32Array(320).fill(value))[0]!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
describe("meeting microphone boundary", () => {
  it("preserves samples across browser blocks and encodes little-endian clipping", () => {
    const pcm = new JourFixePcmFramer(16_000);
    expect(pcm.push(new Float32Array(128).fill(-2))).toEqual([]);
    expect(pcm.push(new Float32Array(128).fill(2))).toEqual([]);
    const result = pcm.push(new Float32Array(128).fill(Number.NaN));
    expect(result).toHaveLength(1);
    const view = new DataView(result[0]!.buffer);
    expect(view.getInt16(0, true)).toBe(-32768);
    expect(view.getInt16(128 * 2, true)).toBe(32767);
    expect(view.getInt16(256 * 2, true)).toBe(0);
    expect(result[0]!.byteLength).toBe(640);
    expect(pcm.push(new Float32Array(256))).toHaveLength(1);
  });
  it("rejects a different audio rate and clears unfinished samples on cancellation", () => {
    expect(() => new JourFixePcmFramer(48_000)).toThrow("16 kHz");
    const pcm = new JourFixePcmFramer(16_000);
    pcm.push(new Float32Array(319).fill(1));
    pcm.clear();
    expect(pcm.push(new Float32Array(1))).toEqual([]);
    const result = pcm.push(new Float32Array(319));
    expect(result[0]!.every((value) => value === 0)).toBe(true);
  });
  it("keeps bounded pre-roll and finishes at a sentence pause", () => {
    const vad = new JourFixeUtteranceSegmenter();
    for (let index = 0; index < 100; index++) expect(vad.push(frame(0))).toEqual([]);
    const start = vad.push(frame(0.1));
    expect(start[0]).toEqual({ type: "begin" });
    expect(start.filter((event) => event.type === "frame")).toHaveLength(11);
    for (let index = 0; index < 29; index++) expect(vad.push(frame(0)).at(-1)?.type).toBe("frame");
    expect(vad.push(frame(0)).at(-1)).toEqual({ type: "finish", reason: "silence" });
    expect(vad.push(frame(0.1)).map((event) => event.type)).toEqual(["begin", "frame"]);
  });
  it("splits continuous speech below 15 s without duplicated or lost frames", () => {
    const vad = new JourFixeUtteranceSegmenter();
    let begins = 0;
    let frames = 0;
    let finishes = 0;
    for (let index = 0; index < 1401; index++) {
      for (const event of vad.push(frame(0.1))) {
        if (event.type === "begin") begins++;
        if (event.type === "frame") frames++;
        if (event.type === "finish") { finishes++; expect(event.reason).toBe("limit"); }
      }
    }
    expect({ begins, frames, finishes }).toEqual({ begins: 3, frames: 1401, finishes: 2 });
    expect(vad.finish()).toEqual([{ type: "finish", reason: "stopped" }]);
    expect(vad.finish()).toEqual([]);
  });
  it("cancels VAD context without inventing a recognized final transcript", () => {
    const vad = new JourFixeUtteranceSegmenter();
    vad.push(frame(0.1));
    vad.clear();
    expect(vad.finish()).toEqual([]);
    expect(() => vad.push(new Uint8Array(4))).toThrow("Invalid");
  });
  it("serializes async writes and owns the queued bytes", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const written: number[] = [];
    const drain = new JourFixeAudioDrain(async (pcm) => {
      written.push(pcm[0]!);
      if (written.length === 1) await first.promise;
      else second.resolve();
    }, (error) => { throw error; });
    const packet = frame(0);
    packet[0] = 1;
    drain.push(packet);
    packet[0] = 2;
    drain.push(packet);
    packet[0] = 3;
    expect(written).toEqual([1]);
    first.resolve();
    await second.promise;
    expect(written).toEqual([1, 2]);
    drain.stop();
  });
  it("aborts on overflow once and never flushes queued audio into another context", async () => {
    const waiting = deferred<void>();
    const errors: Error[] = [];
    const signals: AbortSignal[] = [];
    const drain = new JourFixeAudioDrain(async (_, signal) => { signals.push(signal); await waiting.promise; }, (error) => errors.push(error));
    for (let index = 0; index < 10; index++) drain.push(frame(0.1));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("cannot keep up");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    drain.push(frame(0.1));
    waiting.resolve();
    await waiting.promise;
    expect(signals).toHaveLength(1);
  });
});
