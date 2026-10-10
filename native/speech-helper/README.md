# macOS meeting speech helper, protocol v1

Models owns this macOS26+ Swift helper. Main owns signed app packaging, Electron
supervision/preload and the existing JourFixeSpeechProvider adapter. Crew owns
the authorized native transcript receipt. The helper processes audio and has
no Business OS authority, account, provider token, socket or runtime env switch.

Main's agreed boundary:
~/.codex/task-evidence/workjet/pr73-current-desktop-20260930/jour-fixe-local-speech-boundary-v1-20261008.json.
Bundle Contents/Resources/speech-helper/workjet-speech-helper, signed with the
existing Workjet identity. Electron main resolves resourcesPath; renderer
input cannot choose an executable, shell command, path, file or URL.

## Delivery deadline

Continue local GPU Voxtral. If installed streaming STT+TTS are not measured
green by **2026-10-10 20:00 Europe/Berlin**, select this macOS path for the
Monday12Oct13:00 Jour fixe. Ship after the frozen room release0.0.55.
Neither compilation nor a contract proves installed readiness. Never switch
providers silently within a live session.

## Input and room binding

One JSON object per newline on stdin. Every command requires:

    {"protocolVersion":1,"command":"status","requestId":"unique-operation",
     "instanceId":"instance","projectId":"project","meetingId":"meeting","deckRevision":1}

The first valid command binds the child to that exact room/deck. Wrong scope
or revision is rejected. Each transcription/synthesis has a distinct requestId
which cannot be reused once it ends/cancels. At most2048 completed operations
per child. Status has a separate correlation ID.

| Command    | Additional fields and behavior                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| status     | Real device/locale/assets and installed de-DE enhanced/premium voices. No microphone, model execution, asset download or SFSpeechRecognizer authorization.                                                                                  |
| begin      | One German streaming utterance. Optional installAssets:true explicitly permits OS-managed model asset setup; omitted/false returns assets_missing. Wait for ready before append. Setup is separate from utterance timing.                   |
| append     | sequence0..n, audioBase64:20ms monoPCM16 little-endian,16kHz,320samples/640bytes. Last shorter nonempty even frame allowed. AVAudioConverter explicitly resamples and flushes at end.                                                       |
| end        | Finish input, finalize analyzer, drain results, emit one final candidate. Main waits for final plus verified native receipt before onCommitted/termination.                                                                                 |
| cancel     | Idempotent request cancellation, discards late results. Owner close/instance switch uses this instead of end.                                                                                                                               |
| synthesize | Authorized text <=4096UTF-8bytes, optional slideId. Main resolves exact authorized slide/answer text. Use existing de-DE premium, else enhanced voice; neither available gives voice_missing. No default/personal/cloud voice substitution. |

SpeechAnalyzer/SpeechTranscriber use progressive local results. No
SFSpeechRecognizer or vendor/cloud inference endpoint. Only installAssets:true
may download Apple's OS-managed model assets. Main retains microphone
permission/capture/VAD; helper receives PCM and never opens a capture device.

## Output and bounds

Each valid event echoes all scope/request fields above plus helperMs.
Main rejects another child, scope, generation or retired request.
Crew's local-candidate receipt proves authenticated Owner persistence in that
exact live room/deck/request, with `provider_verified:false`. Main separately
validates the signed helper. The existing gateway-only VerifiedTranscriptFinal
cannot be minted from helper JSON; text append is also insufficient because it
lacks the local request/deck binding. Main uses the native
ctox.workjet.jour_fixe.transcript.local_candidate command through the paired
Shell's project.jour_fixe.transcript.local_candidate action. The native `biz_`
instance comes from trusted Shell.syncConfig; operationId/requestId bind one
final emission, with expectedRevision/deckRevision and exact text SHA in the
completed localCandidate receipt. Source contract availability is not installed
readiness; never invent a gateway execution attestation.

For slide narration, synthesize the exact stored slide.body_markdown unchanged.
Main assembles actual PCM into WAV, uploads through existing desktop_files/chunks
with explicit canonical owner_id and exact generation_id, then invokes
ctox.workjet.jour_fixe.narration.local_publish. This publication is stricter than
the helper transport: WAV <=8MiB and <=300s; mono/stereo PCM16/24/32 or float32 at
16/22.05/24/44.1/48kHz. Native verifies audio/narration-text SHA, owner, current
room/deck/slide and file generation before freezing AudioRef+meeting+receipt.
Its authenticated_owner_local_audio provenance has provider_verified:false;
synthesis_duration_ms=0 is not a timing measurement. Keep actual helper/UI
latency separately. Every slide needs real authorized audio before ready/live.
See CTOX docs/workjet-jour-fixe-local-transcript.md and
docs/workjet-jour-fixe-local-narration.md for the native DTOs.

| Event          | Payload                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| status         | capabilities:available,germanSupported,germanInstalled,germanVoices[],audioProcessedOnDevice:true. Voices have identifier/language/quality.       |
| ready          | Analyzer loaded/prepared; now feed audio.                                                                                                         |
| appended       | sequence acknowledgement; Main honors pipe backpressure and caps unacknowledged frames at32.                                                      |
| partial        | Revisable text,candidateOnly:true; not a receipt.                                                                                                 |
| final          | Aggregate text,candidateOnly:true,endToFinalMs. Main still needs Crew's authorized receipt. Empty is a real no-speech result, not invented text.  |
| audio          | sequence,audioBase64,sampleRate,channels:1,format:s16le,firstAudioMs. Ordered decoded PCM.                                                        |
| audio_end      | bytes,sampleRate,channels:1,format:s16le,firstAudioMs,actual voice. Main validates sequence/size/format and builds a PCM16 WAV Blob. No file URL. |
| cancelled      | Discard subsequent request output.                                                                                                                |
| error          | Classified code; discard incomplete narration.                                                                                                    |
| protocol_error | No trustworthy input scope. Main closes child and settles pending requests.                                                                       |

16KiB/line;4096decoded bytes/output PCM chunk; PCM+44byte WAV <=32MiB;
utterance<=14s; command/analysis/native-audio queues each<=32; native TTS
callback buffer<=256KiB. Overflow fails the request, never drops speech
silently. Malformed framing/EOF stops processing. Broken stdout exits74.
Codes:invalid_request,scope_mismatch,audio_order,overflow,busy,
unsupported_device,unsupported_locale,assets_missing,asset_install_failed,
voice_missing,audio_format,native_speech_failed,cancelled,timeout.
Raw native error text and audio/text are not logged to stderr.

Deadlines:setup15s (explicit asset setup120s),capture30s including14s input,
final drain10s,synthesis60s. Main enforces child-bound deadlines, records its
PID, kills only that child on timeout/abort, handles all pipe errors including
EPIPE, settles pending calls and bounds stderr. EOF cancels owned work and
releases only locale reservations created by this helper. Normal end drains
final+receipt; cancel discards final.

## Missing German narration voice

If status reports an empty germanVoices list, synthesis returns voice_missing.
Install a German Enhanced/Premium voice in System Settings → Accessibility →
Read & Speak → the information button beside System voice → German → download
the enhanced/premium voice. Wait for the download to finish, then start a new
helper and check status again. No provider login is needed.
Apple's macOS26 instructions: https://support.apple.com/guide/mac-help/mchlp2290/26/mac/26.

## Measurement and installed acceptance

helperMs is milliseconds since this child started, from monotonic DispatchTime
uptime. endToFinalMs:helper receipt of end -> fully drained final candidate.
firstAudioMs:synthesis receipt -> first native buffer consumed for output.
They are diagnostic intervals, not cross-process timestamps.

Main measures sentence-end -> final -> confirmed native receipt/UI entirely
on renderer performance.now; include600ms VAD silence plus IPC/persistence.
Never subtract helperMs from performance.now. Also measure narration request
-> first playable/audible audio in one UI clock domain, separately from helper
first-buffer latency. Verify German accuracy/intelligibility.

Proof required:actual signed helper/team/hash in installed Workjet; real
partial before end and confirmed scoped native final; narration/audio/voice;
sentence-end->transcript <=~1500ms; first audio measured. Exercise room
close/cancel/drain,child exit/EPIPE,wrong scope/deck,queue overflow and pending
receipt. Web/mobile cannot call a desktop helper; show unsupported surface.

## Build

No third-party dependencies. Mac-only compilation/tests use the shared gate:

    greppy bash-smart -- /usr/bin/python3 ~/.codex/bin/dev-heavy-run.py \
      --owner <owner> --project workjet --task macos-speech-helper \
      --artifact-volume tmp -- bash native/speech-helper/check.sh

Scratch/module caches use gate artifact paths. Main signs/packages using its
normal release path; this source acquires no signing identity and edits no live
installation. Installed evidence (including failures):
~/.codex/task-evidence/teilziele/20-speech-\*.json.

The same gated check can append `--probe` for a bounded helper-only run. It
synthesizes a known German sentence, then feeds its PCM at20ms intervals with
600ms final silence; it records first PCM, partials before end, accuracy and
end-to-candidate timings in the gate TMPDIR. Missing voices/assets are real
failures. It never claims microphone, signing, room latency or native receipt
acceptance. `probe.py --install-assets` explicitly allows OS-managed German
STT asset setup; use it through the gate only, after confirming root capacity.

Official API sources:

- https://developer.apple.com/documentation/speech/speechanalyzer
- https://developer.apple.com/documentation/speech/speechtranscriber
- https://developer.apple.com/documentation/speech/assetinventory
- https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition
- https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer/write(_:tobuffercallback:)
