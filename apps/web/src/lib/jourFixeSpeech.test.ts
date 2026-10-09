import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  JourFixeSpeechSession,
  type JourFixeSpeechProvider,
  type JourFixeSpeechScope,
} from "./jourFixeSpeech";

const scope: JourFixeSpeechScope = {
  instanceId: "instance-a",
  projectId: "project-a",
  meetingId: "meeting-a",
  deckRevision: 3,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(kind: JourFixeSpeechProvider["kind"] = "ctox-gateway") {
  let listening!: Parameters<JourFixeSpeechProvider["startListening"]>[0];
  const stop = vi.fn(async () => {});
  const provider: JourFixeSpeechProvider = {
    kind,
    startListening: vi.fn(async (options) => {
      listening = options;
      return { stop };
    }),
    prepareNarration: vi.fn(async () => new Blob(["wav"], { type: "audio/wav" })),
  };
  const events = {
    onMicrophone: vi.fn(),
    onPartial: vi.fn(),
    onCommitted: vi.fn(),
    onAudio: vi.fn(),
    onError: vi.fn(),
  };
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:narration");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const session = new JourFixeSpeechSession(provider, scope, events);
  return { provider, session, events, stop, listening: () => listening };
}
afterEach(() => vi.restoreAllMocks());

describe("Jour fixe speech provider boundary", () => {

  it("uses a persisted native rate and refuses an invalid rate before creating an audio URL", async () => {
    const f = fixture();
    f.provider.prepareNarration = vi.fn(async () => ({ blob: new Blob(["wav"], { type: "audio/wav" }), rate: 1.3 }));
    await f.session.prepareNarration("slide-a");
    expect(f.events.onAudio).toHaveBeenLastCalledWith({ ...scope, slideId: "slide-a", blobUrl: "blob:narration", rate: 1.3 });
    f.provider.prepareNarration = vi.fn(async () => ({ blob: new Blob(["wav"], { type: "audio/wav" }), rate: 2 }));
    await f.session.prepareNarration("slide-b");
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(f.events.onError).toHaveBeenLastCalledWith(expect.objectContaining({ message: "Narration has an invalid speaking speed." }));
    f.session.close();
  });

  it("releases the microphone state after a bounded utterance and rejects late callbacks", async () => {
    const f = fixture();
    await f.session.toggleMicrophone();
    const previous = f.listening();
    previous.onCommitted();
    previous.onStopped?.();
    expect(previous.signal.aborted).toBe(true);
    expect(f.events.onMicrophone).toHaveBeenLastCalledWith(false);
    previous.onCommitted();
    expect(f.events.onCommitted).toHaveBeenCalledOnce();
    await f.session.toggleMicrophone();
    expect(f.provider.startListening).toHaveBeenCalledTimes(2);
    f.session.close();
  });
  for (const kind of ["local-helper", "ctox-gateway"] as const) {
    it(`uses the same scoped microphone/narration contract for ${kind}`, async () => {
      const f = fixture(kind);
      await f.session.toggleMicrophone();
      expect(f.listening().scope).toEqual(scope);
      expect(Object.isFrozen(f.listening().scope)).toBe(true);
      f.listening().onPartial({ streamId: "stream", sequence: 1, text: "Draft" });
      expect(f.events.onPartial).toHaveBeenLastCalledWith({
        streamId: "stream",
        sequence: 1,
        text: "Draft",
      });
      expect(f.events.onCommitted).not.toHaveBeenCalled();
      f.listening().onCommitted();
      expect(f.events.onCommitted).toHaveBeenCalledOnce();
      await f.session.prepareNarration("slide-a");
      expect(f.provider.prepareNarration).toHaveBeenCalledWith({
        scope,
        slideId: "slide-a",
        signal: expect.any(AbortSignal),
      });
      expect(f.events.onAudio).toHaveBeenLastCalledWith({
        ...scope,
        slideId: "slide-a",
        blobUrl: "blob:narration",
        rate: 1.15,
      });
      f.session.close();
      expect(f.listening().signal.aborted).toBe(true);
      expect(f.stop).toHaveBeenCalledOnce();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:narration");
    });
  }
  it("cancels pending permission/helper startup and releases its late handle", async () => {
    const f = fixture();
    const pending = deferred<{ stop: () => Promise<void> }>();
    let options!: Parameters<JourFixeSpeechProvider["startListening"]>[0];
    f.provider.startListening = vi.fn((value) => {
      options = value;
      return pending.promise;
    });
    const start = f.session.toggleMicrophone();
    f.session.close();
    expect(options.signal.aborted).toBe(true);
    options.onPartial({ streamId: "late", sequence: 1, text: "Foreign room" });
    options.onCommitted();
    options.onError(new Error("late"));
    pending.resolve({ stop: f.stop });
    await start;
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.events.onPartial).not.toHaveBeenCalled();
    expect(f.events.onCommitted).not.toHaveBeenCalled();
    expect(f.events.onError).not.toHaveBeenCalled();
  });
  it("cancels pending narration on close without making a playable URL", async () => {
    const f = fixture();
    const pending = deferred<Blob>();
    let signal!: AbortSignal;
    f.provider.prepareNarration = vi.fn((options) => {
      signal = options.signal;
      return pending.promise;
    });
    const prepare = f.session.prepareNarration("slide-a");
    f.session.close();
    expect(signal.aborted).toBe(true);
    pending.resolve(new Blob(["wav"], { type: "audio/wav" }));
    await prepare;
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(f.events.onAudio).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it("does not let an old slide replace newer narration", async () => {
    const f = fixture();
    const pending = deferred<Blob>();
    const oldSignals: AbortSignal[] = [];
    f.provider.prepareNarration = vi.fn((options) => {
      oldSignals.push(options.signal);
      return options.slideId === "old"
        ? pending.promise
        : Promise.resolve(new Blob(["new"], { type: "audio/wav" }));
    });
    const old = f.session.prepareNarration("old");
    await f.session.prepareNarration("new");
    pending.resolve(new Blob(["old"], { type: "audio/wav" }));
    await old;
    expect(oldSignals[0]!.aborted).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(f.events.onAudio).toHaveBeenLastCalledWith({
      ...scope,
      slideId: "new",
      blobUrl: "blob:narration",
        rate: 1.15,
    });
    f.session.close();
  });
  it("finishes a user stop before another stream can start, then clears partial text", async () => {
    const f = fixture();
    const draining = deferred<void>();
    f.stop.mockImplementation(() => draining.promise);
    await f.session.toggleMicrophone();
    const stop = f.session.toggleMicrophone();
    await f.session.toggleMicrophone();
    expect(f.provider.startListening).toHaveBeenCalledOnce();
    expect(f.listening().signal.aborted).toBe(false);
    f.listening().onCommitted();
    expect(f.events.onCommitted).toHaveBeenCalledOnce();
    f.session.close();
    expect(f.listening().signal.aborted).toBe(true);
    draining.resolve();
    await stop;
  });
  it("reports provider denial and capture failure without automatic provider fallback", async () => {
    const f = fixture("local-helper");
    const denial = new Error("Speech permission denied.");
    f.provider.startListening = vi.fn(async () => {
      throw denial;
    });
    await f.session.toggleMicrophone();
    expect(f.events.onError).toHaveBeenCalledWith(denial);
    expect(f.events.onMicrophone).toHaveBeenLastCalledWith(false);
    expect(f.provider.prepareNarration).not.toHaveBeenCalled();
    f.session.close();
    const other = fixture();
    await other.session.toggleMicrophone();
    other.listening().onError(denial);
    expect(other.listening().signal.aborted).toBe(true);
    expect(other.stop).toHaveBeenCalledOnce();
    expect(other.events.onPartial).toHaveBeenLastCalledWith(undefined);
    other.session.close();
  });
  it("rejects non-audio narration and releases a previous blob on slide change", async () => {
    const f = fixture();
    await f.session.prepareNarration("slide-a");
    f.provider.prepareNarration = vi.fn(async () => new Blob(["<html>"], { type: "text/html" }));
    await f.session.prepareNarration("slide-b");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:narration");
    expect(f.events.onAudio).toHaveBeenLastCalledWith(undefined);
    expect(f.events.onError).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    f.session.close();
  });
});
