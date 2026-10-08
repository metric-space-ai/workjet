import { JourFixePcmFramer, type JourFixePcmFrame } from "./jourFixePcmCapture";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, constructor: typeof AudioWorkletProcessor): void;

class JourFixeMicrophoneProcessor extends AudioWorkletProcessor {
  private readonly framer = new JourFixePcmFramer(sampleRate);
  private ended = false;
  constructor() {
    super();
    this.port.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.data !== "finish" || this.ended) return;
      this.ended = true;
      const tail = this.framer.flush();
      if (tail) this.emit(tail);
      this.port.postMessage({ type: "ended" }, []);
    });
    this.port.start();
  }
  private emit(frame: JourFixePcmFrame) {
    this.port.postMessage({ type: "frame", ...frame }, [frame.pcm.buffer]);
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // Keep the graph alive without playing captured speech through the speakers.
    for (const channel of outputs[0] ?? []) channel.fill(0);
    if (this.ended) return false;
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels)
      for (let i = 0; i < mono.length; i++)
        mono[i] = mono[i]! + (channel[i] ?? 0) / channels.length;
    try {
      for (const frame of this.framer.push(mono)) this.emit(frame);
    } catch {
      this.ended = true;
      this.port.postMessage({ type: "failed" }, []);
    }
    return !this.ended;
  }
}
registerProcessor("workjet-jour-fixe-pcm", JourFixeMicrophoneProcessor);
