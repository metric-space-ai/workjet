import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { captureJourFixeMicrophone } from "./jourFixeBrowserMicrophone";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function browserFixture() {
  const track = { stop: vi.fn() };
  const media = { getTracks: () => [track] };
  const port = Object.assign(new EventTarget(), { start: vi.fn(), close: vi.fn(), postMessage: vi.fn() });
  const node = Object.assign(new EventTarget(), { port, connect: vi.fn(), disconnect: vi.fn() });
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const context = { audioWorklet: { addModule: vi.fn(async () => {}) }, destination: {},
    createMediaStreamSource: vi.fn(() => source), resume: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const getUserMedia = vi.fn(async () => media);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
  vi.stubGlobal("AudioWorkletNode", class { constructor() { return node; } });
  return { track, media, port, node, context, getUserMedia };
}
describe("browser microphone resource custody", () => {
  it("releases a permission result arriving after room abort", async () => {
    const f = browserFixture(); let resolve!: (value: typeof f.media) => void;
    f.getUserMedia.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const controller = new AbortController();
    const start = captureJourFixeMicrophone({ signal: controller.signal, onFrame: vi.fn(), onError: vi.fn() });
    controller.abort(); await expect(start).rejects.toThrow("canceled");
    resolve(f.media); await Promise.resolve();
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.context.audioWorklet.addModule).not.toHaveBeenCalled();
  });
  it("flushes a final partial PCM frame before releasing tracks and graph", async () => {
    const f = browserFixture(); const onFrame = vi.fn();
    const capture = await captureJourFixeMicrophone({ signal: new AbortController().signal, onFrame, onError: vi.fn() });
    f.port.postMessage.mockImplementation(() => {
      f.port.dispatchEvent(new MessageEvent("message", { data: { type: "frame", pcm: new Uint8Array(40), voiced: true } }));
      f.port.dispatchEvent(new MessageEvent("message", { data: { type: "ended" } }));
    });
    await capture.finish();
    expect(onFrame).toHaveBeenCalledExactlyOnceWith({ pcm: new Uint8Array(40), voiced: true });
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.context.close).toHaveBeenCalledOnce();
    expect(f.port.close).toHaveBeenCalledOnce(); capture.cancel(); expect(f.track.stop).toHaveBeenCalledOnce();
  });
  it("bounds a stalled worklet flush and closes all capture resources", async () => {
    vi.useFakeTimers(); const f = browserFixture();
    const capture = await captureJourFixeMicrophone({ signal: new AbortController().signal, onFrame: vi.fn(), onError: vi.fn() });
    const outcome = expect(capture.finish()).rejects.toThrow("flush timed out");
    await vi.advanceTimersByTimeAsync(501); await outcome;
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.context.close).toHaveBeenCalledOnce();
  });
});
