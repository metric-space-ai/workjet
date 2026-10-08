export interface JourFixePcmFrame {
  readonly pcm: Uint8Array;
  readonly voiced: boolean;
}

/** Streaming linear resampling; frame boundaries never reset the source clock. */
export class JourFixePcmFramer {
  private inputCount = 0;
  private outputCount = 0;
  private last = 0;
  private frame = new Int16Array(1600);
  private used = 0;
  private energy = 0;
  constructor(readonly sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate < 16_000 || sampleRate > 192_000)
      throw new Error("Unsupported microphone sample rate.");
  }
  push(mono: Float32Array): JourFixePcmFrame[] {
    if (mono.length > 16_384 || !mono.every(Number.isFinite))
      throw new Error("Invalid microphone samples.");
    const start = this.inputCount;
    const end = start + mono.length;
    const frames: JourFixePcmFrame[] = [];
    while (mono.length) {
      const position = (this.outputCount * this.sampleRate) / 16_000;
      const lower = Math.floor(position);
      const fraction = position - lower;
      if (lower >= end || (fraction > 0 && lower + 1 >= end)) break;
      const a = lower < start ? this.last : mono[lower - start]!;
      const b = fraction === 0 ? a : mono[lower + 1 - start]!;
      const value = Math.max(-1, Math.min(1, a + (b - a) * fraction));
      this.frame[this.used++] = Math.round(value < 0 ? value * 32768 : value * 32767);
      this.energy += value * value;
      this.outputCount++;
      if (this.used === 1600) frames.push(this.take());
    }
    this.inputCount = end;
    if (mono.length) this.last = mono[mono.length - 1]!;
    return frames;
  }
  flush(): JourFixePcmFrame | undefined {
    return this.used ? this.take() : undefined;
  }
  private take(): JourFixePcmFrame {
    const pcm = new Uint8Array(this.used * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < this.used; i++) view.setInt16(i * 2, this.frame[i]!, true);
    const voiced = Math.sqrt(this.energy / this.used) >= 0.012;
    this.used = 0;
    this.energy = 0;
    return { pcm, voiced };
  }
}

/** End one utterance after 600ms trailing silence; no silence-only final. */
export class JourFixeUtteranceActivity {
  private voice = false;
  private quietSamples = 0;
  accept(frame: JourFixePcmFrame): boolean {
    if (frame.voiced) {
      this.voice = true;
      this.quietSamples = 0;
    } else if (this.voice) this.quietSamples += frame.pcm.byteLength / 2;
    return this.voice && this.quietSamples >= 9600;
  }
  hasVoice(): boolean {
    return this.voice;
  }
}
