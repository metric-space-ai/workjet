export const JOUR_FIXE_SAMPLE_RATE = 16_000;
export const JOUR_FIXE_FRAME_SAMPLES = 320;

/** 20 ms PCM16LE frames; input must come from a 16 kHz AudioContext. */
export class JourFixePcmFramer {
  private pending = new Float32Array(JOUR_FIXE_FRAME_SAMPLES);
  private used = 0;

  constructor(sampleRate: number) {
    if (sampleRate !== JOUR_FIXE_SAMPLE_RATE) throw new Error("Microphone requires 16 kHz audio.");
  }

  push(samples: Float32Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (const value of samples) {
      this.pending[this.used++] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      if (this.used !== JOUR_FIXE_FRAME_SAMPLES) continue;
      const frame = new Uint8Array(JOUR_FIXE_FRAME_SAMPLES * 2);
      const view = new DataView(frame.buffer);
      for (let index = 0; index < this.pending.length; index++) {
        const sample = this.pending[index]!;
        view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      }
      frames.push(frame);
      this.used = 0;
    }
    return frames;
  }

  clear() {
    this.pending.fill(0);
    this.used = 0;
  }
}

export type JourFixeUtteranceEvent =
  | { readonly type: "begin" }
  | { readonly type: "frame"; readonly pcm: Uint8Array }
  | { readonly type: "finish"; readonly reason: "silence" | "limit" | "stopped" };

/** Energy VAD is only an utterance boundary, never a claim that speech was recognized. */
export class JourFixeUtteranceSegmenter {
  private preRoll: Uint8Array[] = [];
  private active = false;
  private frames = 0;
  private quietFrames = 0;

  push(pcm: Uint8Array): JourFixeUtteranceEvent[] {
    if (pcm.byteLength !== JOUR_FIXE_FRAME_SAMPLES * 2) throw new Error("Invalid microphone frame.");
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let energy = 0;
    for (let index = 0; index < JOUR_FIXE_FRAME_SAMPLES; index++) {
      const value = view.getInt16(index * 2, true) / 32768;
      energy += value * value;
    }
    const voiced = Math.sqrt(energy / JOUR_FIXE_FRAME_SAMPLES) >= (this.active ? 0.006 : 0.012);
    const events: JourFixeUtteranceEvent[] = [];
    if (!this.active) {
      if (!voiced) {
        this.preRoll.push(pcm.slice());
        if (this.preRoll.length > 10) this.preRoll.shift();
        return events;
      }
      this.active = true;
      this.frames = this.preRoll.length;
      events.push({ type: "begin" }, ...this.preRoll.map((frame) => ({ type: "frame" as const, pcm: frame })));
      this.preRoll = [];
    }
    events.push({ type: "frame", pcm });
    this.frames++;
    this.quietFrames = voiced ? 0 : this.quietFrames + 1;
    // Finish at 14 s, below the receiver's hard 15 s limit, including pre-roll.
    if (this.frames >= 700 || this.quietFrames >= 30) {
      events.push({ type: "finish", reason: this.frames >= 700 ? "limit" : "silence" });
      this.clear();
    }
    return events;
  }

  finish(): JourFixeUtteranceEvent[] {
    const events: JourFixeUtteranceEvent[] = this.active ? [{ type: "finish", reason: "stopped" }] : [];
    this.clear();
    return events;
  }

  clear() {
    this.preRoll = [];
    this.active = false;
    this.frames = 0;
    this.quietFrames = 0;
  }
}

/** Serializes writes; overflow cancels the stream instead of dropping a frame. */
export class JourFixeAudioDrain {
  private queue: Uint8Array[] = [];
  private running = false;
  private stopped = false;
  private readonly controller = new AbortController();

  constructor(
    private readonly write: (frame: Uint8Array, signal: AbortSignal) => Promise<void>,
    private readonly onError: (error: Error) => void,
  ) {}

  push(frame: Uint8Array) {
    if (this.stopped) return;
    if (frame.byteLength !== JOUR_FIXE_FRAME_SAMPLES * 2) {
      this.fail(new Error("Invalid microphone frame."));
      return;
    }
    if (this.queue.length >= 8) {
      this.fail(new Error("Audio connection cannot keep up. Microphone stopped; reconnect to continue."));
      return;
    }
    this.queue.push(frame.slice());
    void this.drain();
  }

  stop() {
    this.stopped = true;
    this.queue = [];
    this.controller.abort();
  }

  private fail(error: Error) {
    if (this.stopped) return;
    this.stop();
    this.onError(error);
  }

  private async drain() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped && this.queue.length) {
        const frame = this.queue.shift()!;
        await this.write(frame, this.controller.signal);
      }
    } catch (error) {
      if (!this.stopped) this.fail(error instanceof Error ? error : new Error("Audio connection failed."));
    } finally {
      this.running = false;
    }
  }
}
