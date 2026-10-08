# Jour fixe microphone capture

The browser capture boundary uses a 16 kHz mono AudioContext and emits 20 ms PCM16LE packets. It must be started by the microphone action, with an AbortSignal tied to the selected instance, project, meeting and deck revision. Cancelling the scope releases tracks, worklet and context, including a permission request that completes late. No local recording is retained.

Writes are serialized with at most eight queued packets. Overflow aborts capture and reports a reconnect error; it does not silently skip packets. The consumer must honor the supplied abort signal and cancel its authorized gateway stream.

The energy segmenter retains at most 200 ms of pre-roll, ends an utterance after 600 ms of silence and splits continuous speech at 14 s, below the native receiver's 15 s maximum. These boundaries do not identify a speaker or assert that speech was recognized. Partial text remains transient; only a verified final producer receipt may enter the native meeting transcript.

This package prepares capture and utterance boundaries. The room microphone stays unavailable until the selected instance exposes the authorized gateway consumer and Crew's final-receipt binding. It does not manufacture a transcript, speaker, source-run ID or native receipt. Desktop/web browser capture is covered here; the separate React Native host still requires its native audio adapter and installed acceptance.
