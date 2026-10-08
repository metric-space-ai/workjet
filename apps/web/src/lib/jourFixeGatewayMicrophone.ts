import { openJourFixeGatewaySpeech, isJourFixePrivateFinalReceipt } from "./jourFixeGatewaySpeech";
import {
  captureJourFixeMicrophone,
  type JourFixeMicrophoneCapture,
  type JourFixeMicrophoneCaptureFactory,
} from "./jourFixeBrowserMicrophone";
import { JourFixeUtteranceActivity } from "./jourFixePcmCapture";
import type { JourFixeSpeechProvider } from "./jourFixeSpeech";
import type { WorkjetProjectControlPort } from "../workjetProjectControl";

/** Supply only after installed transport/binding is authorized. This is not a readiness probe. */
export function createJourFixeGatewayMicrophoneProvider(dependencies: {
  readonly prepareNarration: JourFixeSpeechProvider["prepareNarration"];
  readonly port?: WorkjetProjectControlPort;
  readonly capture?: JourFixeMicrophoneCaptureFactory;
}): JourFixeSpeechProvider {
  return {
    kind: "ctox-gateway",
    prepareNarration: dependencies.prepareNarration,
    async startListening(options) {
      if (options.signal.aborted) throw new DOMException("Speech scope canceled.", "AbortError");
      const controller = new AbortController();
      let capture: JourFixeMicrophoneCapture | undefined;
      let stopped = false;
      let finishing = false;
      let completion: Promise<void> | undefined;
      let text = "";
      let sequence = 0;
      const activity = new JourFixeUtteranceActivity();
      const current = () => !stopped && !options.signal.aborted && !controller.signal.aborted;
      const cancel = () => {
        stopped = true;
        capture?.cancel();
        controller.abort();
        clearTimeout(timer);
        options.signal.removeEventListener("abort", cancel);
      };
      const detach = () => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", cancel);
      };
      const fail = (reason: unknown) => {
        if (!current()) return;
        cancel();
        detach();
        try {
          options.onError(
            reason instanceof Error ? reason : new Error("Microphone capture failed."),
          );
        } catch {
          /* UI callbacks cannot keep recording alive. */
        }
        try {
          options.onStopped?.();
        } catch {
          /* Capture is already canceled. */
        }
      };
      options.signal.addEventListener("abort", cancel, { once: true });
      // Covers permission delay and capture; the native consumer has its own 40s fence.
      const timer = setTimeout(
        () => fail(new Error("Microphone sentence exceeded its deadline.")),
        35_000,
      );
      let stream: Awaited<ReturnType<typeof openJourFixeGatewaySpeech>> | undefined;
      try {
        // Native authorization succeeds before any microphone permission or audio capture.
        stream = await openJourFixeGatewaySpeech({
          scope: options.scope,
          signal: controller.signal,
          ...(dependencies.port ? { port: dependencies.port } : {}),
          onError: fail,
          onPartial: (partial) => {
            if (!current() || partial.sequence <= sequence) return;
            sequence = partial.sequence;
            text += partial.text;
            options.onPartial({ ...partial, text });
          },
        });
        const finish = () => {
          completion ??= (async () => {
            if (!current()) return;
            finishing = true;
            await capture?.finish();
            if (!current()) return;
            if (!activity.hasVoice()) {
              await stream!.cancel();
              return;
            }
            const receipt = await stream!.finish();
            if (!current()) return;
            if (
              !isJourFixePrivateFinalReceipt(receipt) ||
              receipt.scope.instanceId !== options.scope.instanceId ||
              receipt.scope.projectId !== options.scope.projectId ||
              receipt.scope.meetingId !== options.scope.meetingId ||
              receipt.scope.deckRevision !== options.scope.deckRevision
            )
              throw new Error("Native microphone final belongs to another meeting.");
            options.onCommitted();
          })()
            .catch(fail)
            .finally(() => {
              const notify = current();
              cancel();
              detach();
              if (notify) options.onStopped?.();
            });
          return completion;
        };
        capture = await (dependencies.capture ?? captureJourFixeMicrophone)({
          signal: controller.signal,
          onError: fail,
          onFrame: (frame) => {
            if (!current()) return;
            const ended = activity.accept(frame);
            void stream!.write(frame.pcm).catch(fail);
            if (ended && !finishing) void finish();
          },
        });
        if (!current()) {
          capture.cancel();
          await stream.cancel();
          detach();
          return { stop: async () => {} };
        }
        return { stop: finish };
      } catch (error) {
        cancel();
        detach();
        await stream?.cancel().catch(() => {});
        throw error;
      }
    },
  };
}
