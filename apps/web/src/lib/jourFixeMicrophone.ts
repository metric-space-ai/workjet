import { JourFixeAudioDrain, JourFixePcmFramer, JOUR_FIXE_SAMPLE_RATE } from "./jourFixePcm";

// The worklet only captures mono samples. Frame conversion and bounded delivery
// stay in the tested main-thread pipeline; no recording is saved locally.
const PROCESSOR = `class WorkjetMeetingCapture extends AudioWorkletProcessor {
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples?.length) {
      const copy = new Float32Array(samples);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor("workjet-meeting-capture", WorkjetMeetingCapture);`;

/** Invoke from the microphone click, never on mount. Abort on any meeting scope change. */
export async function startJourFixeMicrophone(options: {
  readonly signal: AbortSignal;
  readonly onFrame: (frame: Uint8Array, signal: AbortSignal) => Promise<void>;
  readonly onError: (error: Error) => void;
}): Promise<() => void> {
  let stopped = false;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let mute: GainNode | undefined;
  let moduleUrl: string | undefined;
  const framer = new JourFixePcmFramer(JOUR_FIXE_SAMPLE_RATE);
  const drain = new JourFixeAudioDrain(options.onFrame, fail);
  function stop() {
    if (stopped) return;
    stopped = true;
    options.signal.removeEventListener("abort", stop);
    drain.stop();
    framer.clear();
    for (const track of stream?.getTracks() ?? []) track.stop();
    source?.disconnect();
    worklet?.disconnect();
    worklet?.port.close();
    mute?.disconnect();
    if (context && context.state !== "closed") void context.close().catch(() => {});
    if (moduleUrl) URL.revokeObjectURL(moduleUrl);
    moduleUrl = undefined;
  }
  function fail(error: Error) {
    if (stopped) return;
    stop();
    options.onError(error);
  }
  function checkActive() {
    if (stopped || options.signal.aborted)
      throw new DOMException("Microphone cancelled.", "AbortError");
  }
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    checkActive();
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined")
      throw new Error("Microphone capture is unavailable in this client.");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: JOUR_FIXE_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
    // Permission may resolve after the user leaves. Release those tracks too.
    if (stopped || options.signal.aborted) {
      for (const track of stream.getTracks()) track.stop();
      checkActive();
    }
    context = new AudioContext({ sampleRate: JOUR_FIXE_SAMPLE_RATE });
    if (context.sampleRate !== JOUR_FIXE_SAMPLE_RATE)
      throw new Error("This audio device cannot capture at 16 kHz.");
    moduleUrl = URL.createObjectURL(new Blob([PROCESSOR], { type: "text/javascript" }));
    await context.audioWorklet.addModule(moduleUrl);
    URL.revokeObjectURL(moduleUrl);
    moduleUrl = undefined;
    checkActive();
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, "workjet-meeting-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
    });
    mute = context.createGain();
    mute.gain.value = 0;
    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(context.destination);
    worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      if (stopped) return;
      if (!(event.data instanceof Float32Array) || event.data.length > 4096) {
        fail(new Error("Invalid microphone sample block."));
        return;
      }
      for (const frame of framer.push(event.data)) drain.push(frame);
    };
    worklet.port.onmessageerror = () => fail(new Error("Microphone capture connection failed."));
    worklet.onprocessorerror = () => fail(new Error("Microphone audio processor failed."));
    for (const track of stream.getAudioTracks())
      track.addEventListener("ended", () => fail(new Error("Microphone disconnected.")), {
        once: true,
      });
    await context.resume();
    checkActive();
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
