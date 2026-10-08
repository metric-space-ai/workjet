import type { JourFixePartialTranscript } from "./jourFixeRoom";

export interface JourFixeSpeechScope {
  readonly instanceId: string;
  readonly projectId: string;
  readonly meetingId: string;
  readonly deckRevision: number;
}

/** Implementations own capture/IPC, authorization and final native receipt binding. */
export interface JourFixeSpeechProvider {
  readonly kind: "local-helper" | "ctox-gateway";
  startListening(options: {
    readonly scope: JourFixeSpeechScope;
    readonly signal: AbortSignal;
    readonly onPartial: (partial: JourFixePartialTranscript) => void;
    /** Called only after the final transcript has a verified native meeting receipt. */
    readonly onCommitted: () => void;
    readonly onError: (error: Error) => void;
  }): Promise<{ readonly stop: () => Promise<void> }>;
  /** Resolve authorized narration for this exact slide/deck; never return a file URL. */
  prepareNarration(options: {
    readonly scope: JourFixeSpeechScope;
    readonly slideId: string;
    readonly signal: AbortSignal;
  }): Promise<Blob>;
}

export interface JourFixeSpeechAudio {
  readonly projectId: string;
  readonly meetingId: string;
  readonly deckRevision: number;
  readonly slideId: string;
  readonly blobUrl: string;
}

/** One room owns one selected provider. Closing never falls back to another provider. */
export class JourFixeSpeechSession {
  private closed = false;
  private listening: AbortController | undefined;
  private stopping: AbortController | undefined;
  private stopListening: (() => Promise<void>) | undefined;
  private narration: AbortController | undefined;
  private audioUrl: string | undefined;

  constructor(
    private readonly provider: JourFixeSpeechProvider,
    private readonly scope: JourFixeSpeechScope,
    private readonly events: {
      readonly onMicrophone: (active: boolean) => void;
      readonly onPartial: (partial: JourFixePartialTranscript | undefined) => void;
      readonly onCommitted: () => void;
      readonly onAudio: (audio: JourFixeSpeechAudio | undefined) => void;
      readonly onError: (error: Error) => void;
    },
  ) {
    this.scope = Object.freeze({ ...scope });
  }

  async toggleMicrophone(): Promise<void> {
    if (this.closed || this.stopping) return;
    if (this.listening) {
      // A second click can cancel a permission/helper start that has not resolved.
      const controller = this.listening;
      const stop = this.stopListening;
      this.listening = undefined;
      this.stopping = controller;
      this.stopListening = undefined;
      this.events.onMicrophone(false);
      if (!stop) controller.abort();
      try {
        await stop?.();
      } catch (error) {
        if (!this.closed) this.report(error);
      } finally {
        controller.abort();
        if (this.stopping === controller) this.stopping = undefined;
        if (!this.closed && !this.listening) this.events.onPartial(undefined);
      }
      return;
    }
    const controller = new AbortController();
    this.listening = controller;
    const current = () => !this.closed && !controller.signal.aborted;
    this.events.onMicrophone(true);
    try {
      const handle = await this.provider.startListening({
        scope: this.scope,
        signal: controller.signal,
        onPartial: (partial) => {
          if (current()) this.events.onPartial(partial);
        },
        onCommitted: () => {
          if (current()) {
            this.events.onPartial(undefined);
            this.events.onCommitted();
          }
        },
        onError: (error) => {
          if (!current()) return;
          controller.abort();
          if (this.listening === controller) {
            this.listening = undefined;
            const stop = this.stopListening;
            this.stopListening = undefined;
            void stop?.().catch(() => {});
          }
          this.events.onMicrophone(false);
          this.events.onPartial(undefined);
          this.events.onError(error);
        },
      });
      if (!current()) await handle.stop();
      else this.stopListening = handle.stop;
    } catch (error) {
      const failed = current();
      controller.abort();
      if (this.listening === controller) {
        this.listening = undefined;
        this.stopListening = undefined;
        this.events.onMicrophone(false);
      }
      if (failed) this.report(error);
    }
  }

  async prepareNarration(slideId: string): Promise<void> {
    if (this.closed) return;
    this.narration?.abort();
    this.releaseAudio();
    this.events.onAudio(undefined);
    const controller = new AbortController();
    this.narration = controller;
    try {
      const blob = await this.provider.prepareNarration({
        scope: this.scope,
        slideId,
        signal: controller.signal,
      });
      if (this.closed || controller.signal.aborted) return;
      if (!blob.type.startsWith("audio/") || blob.size === 0 || blob.size > 32 * 1024 * 1024)
        throw new Error("Narration is not a supported audio recording.");
      this.audioUrl = URL.createObjectURL(blob);
      this.events.onAudio({ ...this.scope, slideId, blobUrl: this.audioUrl });
    } catch (error) {
      if (!this.closed && !controller.signal.aborted) this.report(error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listening?.abort();
    this.stopping?.abort();
    this.narration?.abort();
    const stop = this.stopListening;
    this.stopListening = undefined;
    this.listening = undefined;
    void stop?.().catch(() => {});
    this.releaseAudio();
  }

  private releaseAudio() {
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = undefined;
  }

  private report(error: unknown) {
    this.events.onError(error instanceof Error ? error : new Error("Speech connection failed."));
  }
}
