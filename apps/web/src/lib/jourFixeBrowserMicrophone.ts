import workletUrl from "./jourFixeMicrophoneWorklet?worker&url";
import type { JourFixePcmFrame } from "./jourFixePcmCapture";

export interface JourFixeMicrophoneCapture {
  /** Flush the last partial frame, then stop all owned tracks and the audio graph. */
  finish(): Promise<void>;
  cancel(): void;
}
export type JourFixeMicrophoneCaptureFactory = (options: {
  readonly signal: AbortSignal;
  readonly onFrame: (frame: JourFixePcmFrame) => void;
  readonly onError: (error: Error) => void;
}) => Promise<JourFixeMicrophoneCapture>;
const canceled = () => new DOMException("Microphone capture canceled.", "AbortError");

/** Browser-owned microphone only; no upload URL, speech account or text fallback. */
export const captureJourFixeMicrophone: JourFixeMicrophoneCaptureFactory = async (options) => {
  if (options.signal.aborted) throw canceled();
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext)
    throw new Error("Microphone capture is unavailable on this device.");
  let closed = false;
  let media: MediaStream | undefined;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let finishPromise: Promise<void> | undefined;
  let finishResolve: (() => void) | undefined;
  let finishReject: ((reason: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener("abort", stop);
    clearTimeout(timer);
    for (const track of media?.getTracks() ?? []) track.stop();
    source?.disconnect();
    node?.disconnect();
    node?.port.close();
    void context?.close().catch(() => {});
  };
  const stop = () => {
    finishReject?.(canceled());
    cleanup();
  };
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    const requested = navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    // getUserMedia cannot be canceled. A permission result after room-close owns no tracks.
    void requested.then(
      (value) => {
        if (closed || options.signal.aborted) for (const track of value.getTracks()) track.stop();
      },
      () => {},
    );
    media = await new Promise<MediaStream>((resolve, reject) => {
      const abort = () => reject(canceled());
      options.signal.addEventListener("abort", abort, { once: true });
      requested
        .then(resolve, reject)
        .finally(() => options.signal.removeEventListener("abort", abort));
      if (options.signal.aborted) abort();
    });
    if (closed || options.signal.aborted) throw canceled();
    context = new AudioContext();
    await context.audioWorklet.addModule(workletUrl);
    if (closed || options.signal.aborted) throw canceled();
    node = new AudioWorkletNode(context, "workjet-jour-fixe-pcm", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.port.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (closed || options.signal.aborted) return;
      const data = event.data;
      if (!data || typeof data !== "object" || !("type" in data)) return;
      if (data.type === "ended") {
        finishResolve?.();
        return;
      }
      if (
        data.type === "frame" &&
        "pcm" in data &&
        data.pcm instanceof Uint8Array &&
        "voiced" in data &&
        typeof data.voiced === "boolean"
      ) {
        options.onFrame({ pcm: data.pcm, voiced: data.voiced });
        return;
      }
      try { options.onError(new Error("Microphone audio processing failed.")); }
      finally { stop(); }
    });
    node.port.start();
    node.addEventListener("processorerror", () => {
      try { if (!closed) options.onError(new Error("Microphone audio processing failed.")); }
      finally { stop(); }
    });
    source = context.createMediaStreamSource(media);
    source.connect(node);
    node.connect(context.destination);
    await context.resume();
    if (closed || options.signal.aborted) throw canceled();
    return {
      cancel: stop,
      finish() {
        finishPromise ??= new Promise<void>((resolve, reject) => {
          if (closed) {
            reject(canceled());
            return;
          }
          finishResolve = resolve;
          finishReject = reject;
          timer = setTimeout(() => reject(new Error("Microphone flush timed out.")), 500);
          node!.port.postMessage("finish", []);
        }).finally(cleanup);
        return finishPromise;
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
};
