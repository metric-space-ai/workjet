import { describe, expect, it } from "vite-plus/test";
import { JourFixePcmFramer, JourFixeUtteranceActivity } from "./jourFixePcmCapture";

function encode(rate: number, samples: Float32Array, chunk: number) {
  const framer = new JourFixePcmFramer(rate);
  const frames = [];
  for (let i = 0; i < samples.length; i += chunk) frames.push(...framer.push(samples.slice(i, i + chunk)));
  const tail = framer.flush(); if (tail) frames.push(tail);
  return frames;
}
describe("microphone PCM framing", () => {
  it.each([16000, 44100, 48000, 96000])("resamples %iHz into exactly one second of 100ms little-endian PCM", (rate) => {
    const samples = Float32Array.from({ length: rate }, (_, i) => Math.sin(i / 71) * 0.2);
    const frames = encode(rate, samples, 128);
    expect(frames).toHaveLength(10);
    expect(frames.every((frame) => frame.pcm.byteLength === 3200)).toBe(true);
    expect(frames.map((f) => [...f.pcm])).toEqual(encode(rate, samples, 137).map((f) => [...f.pcm]));
  });
  it("retains a partial final frame and clips to signed PCM16LE", () => {
    const frames = encode(16000, new Float32Array([-2, 0, 2]), 3);
    expect([...frames[0]!.pcm]).toEqual([0, 128, 0, 0, 255, 127]);
  });
  it("rejects invalid rate, oversized callback and non-finite samples", () => {
    expect(() => new JourFixePcmFramer(8000)).toThrow();
    const framer = new JourFixePcmFramer(48000);
    expect(() => framer.push(new Float32Array(16385))).toThrow();
    expect(() => framer.push(new Float32Array([NaN]))).toThrow();
  });
  it("ends after 600ms trailing silence and never confirms silence-only capture", () => {
    const activity = new JourFixeUtteranceActivity();
    const quiet = { pcm: new Uint8Array(3200), voiced: false };
    for (let i = 0; i < 20; i++) expect(activity.accept(quiet)).toBe(false);
    expect(activity.hasVoice()).toBe(false);
    expect(activity.accept({ ...quiet, voiced: true })).toBe(false);
    for (let i = 0; i < 5; i++) expect(activity.accept(quiet)).toBe(false);
    expect(activity.accept(quiet)).toBe(true);
  });
});
