import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { startJourFixeMicrophone } from "./jourFixeMicrophone";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function platform() {
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const permission = deferred<MediaStream>();
  const module = deferred<void>();
  const port = { onmessage: null as ((event: MessageEvent<unknown>) => void) | null, onmessageerror: null as (() => void) | null, close: vi.fn() };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const mute = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const close = vi.fn(async () => {});
  const resume = vi.fn(async () => {});
  const disconnect = vi.fn();
  const addModule = vi.fn(() => module.promise);
  class Context {
    sampleRate = 16_000;
    state = "running";
    destination = {};
    audioWorklet = { addModule };
    createMediaStreamSource = () => source;
    createGain = () => mute;
    close = close;
    resume = resume;
  }
  class Worklet {
    port = port;
    connect = vi.fn();
    disconnect = disconnect;
  }
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => permission.promise) } });
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Worklet);
  const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:meeting-worklet");
  const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { track, stream, permission, module, port, source, mute, close, resume, disconnect, addModule, createUrl, revokeUrl };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("meeting microphone lifetime", () => {
  it("releases a late permission result after the meeting scope was cancelled", async () => {
    const host = platform();
    const controller = new AbortController();
    const onError = vi.fn();
    const capture = startJourFixeMicrophone({ signal: controller.signal, onFrame: async () => {}, onError });
    const rejected = expect(capture).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    host.permission.resolve(host.stream);
    await rejected;
    expect(host.track.stop).toHaveBeenCalledTimes(1);
    expect(host.addModule).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
  it("cleans up after an abort during worklet loading", async () => {
    const host = platform();
    const controller = new AbortController();
    const capture = startJourFixeMicrophone({ signal: controller.signal, onFrame: async () => {}, onError: vi.fn() });
    const rejected = expect(capture).rejects.toMatchObject({ name: "AbortError" });
    host.permission.resolve(host.stream);
    await host.permission.promise;
    expect(host.addModule).toHaveBeenCalledTimes(1);
    controller.abort();
    host.module.resolve();
    await rejected;
    expect(host.track.stop).toHaveBeenCalledTimes(1);
    expect(host.close).toHaveBeenCalledTimes(1);
    expect(host.resume).not.toHaveBeenCalled();
    expect(host.revokeUrl).toHaveBeenCalledWith("blob:meeting-worklet");
  });
  it("delivers bounded frames and closes only its own capture on stop", async () => {
    const host = platform();
    const controller = new AbortController();
    const frames: Uint8Array[] = [];
    const capture = startJourFixeMicrophone({ signal: controller.signal, onFrame: async (pcm) => { frames.push(pcm); }, onError: vi.fn() });
    host.permission.resolve(host.stream);
    host.module.resolve();
    const stop = await capture;
    host.port.onmessage?.({ data: new Float32Array(128) } as MessageEvent<unknown>);
    host.port.onmessage?.({ data: new Float32Array(192) } as MessageEvent<unknown>);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.byteLength).toBe(640);
    expect(host.mute.gain.value).toBe(0);
    stop();
    stop();
    host.port.onmessage?.({ data: new Float32Array(320) } as MessageEvent<unknown>);
    expect(frames).toHaveLength(1);
    expect(host.track.stop).toHaveBeenCalledTimes(1);
    expect(host.close).toHaveBeenCalledTimes(1);
    expect(host.port.close).toHaveBeenCalledTimes(1);
    expect(host.disconnect).toHaveBeenCalledTimes(1);
  });
});
