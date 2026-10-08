#!/usr/bin/env python3
"""Bounded helper-only measurement; never substitutes for installed room acceptance."""
import argparse
import base64
import collections
import datetime
import difflib
import json
import math
import os
import pathlib
import queue
import re
import struct
import subprocess
import threading
import time
import uuid

SENTENCE = "Das Projekt ist bereit. Der nächste Schritt ist unser gemeinsamer Test."
MAX_LINE = 16384
MAX_AUDIO = 32 * 1024 * 1024 - 44


class ProbeError(Exception):
    pass


class Child:
    def __init__(self, binary):
        self.events = queue.Queue(maxsize=256)
        self.child = subprocess.Popen([str(binary)], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.thread.start()
        self.scope = dict(protocolVersion=1, instanceId="models-speech-helper-acceptance",
                          projectId="isolated-probe", meetingId=str(uuid.uuid4()), deckRevision=1)
        self.pending = collections.deque()

    def read(self):
        try:
            while True:
                raw = self.child.stdout.readline(MAX_LINE + 2)
                if not raw:
                    raise ProbeError("child_exit")
                if len(raw) > MAX_LINE + 1 or not raw.endswith(b"\n"):
                    raise ProbeError("output_line_bound")
                self.events.put(json.loads(raw), timeout=2)
        except Exception as error:
            try:
                self.events.put(error, timeout=2)
            except queue.Full:
                pass

    def send(self, command, request, **fields):
        data = json.dumps(dict(self.scope, command=command, requestId=request, **fields)).encode()
        if len(data) > MAX_LINE:
            raise ProbeError("input_line_bound")
        self.child.stdin.write(data + b"\n")
        self.child.stdin.flush()

    def next(self, deadline):
        if self.pending:
            value = self.pending.popleft()
        else:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProbeError("probe_timeout")
            try:
                value = self.events.get(timeout=remaining)
            except queue.Empty:
                raise ProbeError("probe_timeout") from None
        if isinstance(value, Exception):
            raise value
        if value.get("event") == "protocol_error":
            raise ProbeError(value.get("code", "protocol_error"))
        for name, expected in self.scope.items():
            if value.get(name) != expected:
                raise ProbeError("unscoped_event")
        if value.get("event") == "error":
            raise ProbeError(value.get("code", "native_speech_failed"))
        return value

    def close(self):
        if self.child.poll() is None:
            try:
                self.send("cancel", "capture")
                self.send("cancel", "narration")
                self.child.stdin.close()
                self.child.wait(timeout=5)
            except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
                self.child.terminate()
                try:
                    self.child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=3)
        self.thread.join(timeout=2)


def resample(pcm, rate):
    samples = struct.unpack("<" + "h" * (len(pcm) // 2), pcm)
    count = math.floor(len(samples) * 16000 / rate)
    output = bytearray()
    for i in range(count):
        position = i * rate / 16000
        left = min(int(position), len(samples) - 1)
        right = min(left + 1, len(samples) - 1)
        value = round(samples[left] + (samples[right] - samples[left]) * (position - left))
        output.extend(struct.pack("<h", max(-32768, min(32767, value))))
    # Keep a short tail after the last audible sample, before explicit VAD silence.
    audible = [i for i in range(len(output) // 2) if abs(struct.unpack_from("<h", output, i * 2)[0]) >= 32]
    if not audible:
        raise ProbeError("silent_narration")
    return bytes(output[:min(len(output), (audible[-1] + 160) * 2)])


def normalized(text):
    return re.findall(r"\w+", text.lower())


def run(binary, report, install_assets):
    started = time.monotonic()
    child = Child(binary)
    report["ownedPid"] = child.child.pid
    try:
        child.send("status", "capabilities")
        status = child.next(time.monotonic() + 15)
        if status.get("event") != "status":
            raise ProbeError("status_missing")
        report["capabilities"] = status.get("capabilities")
        child.send("synthesize", "narration", text=SENTENCE, slideId="fixture-slide")
        synthesis_start = time.monotonic()
        audio = bytearray()
        sequence = 0
        deadline = synthesis_start + 65
        while True:
            event = child.next(deadline)
            if event["requestId"] != "narration":
                raise ProbeError("wrong_request")
            if event["event"] == "audio":
                if event.get("sequence") != sequence or event.get("channels") != 1 or event.get("format") != "s16le":
                    raise ProbeError("audio_order_or_format")
                chunk = base64.b64decode(event["audioBase64"], validate=True)
                if len(chunk) > 4096 or len(chunk) % 2 or len(audio) + len(chunk) > MAX_AUDIO:
                    raise ProbeError("audio_bound")
                if not audio:
                    report["firstTtsPcmAtHostMs"] = (time.monotonic() - synthesis_start) * 1000
                sequence += 1
                audio.extend(chunk)
            elif event["event"] == "audio_end":
                if event.get("bytes") != len(audio) or not audio:
                    raise ProbeError("audio_total")
                report["tts"] = {name: event.get(name) for name in ("voice", "sampleRate", "bytes", "firstAudioMs")}
                report["tts"]["completeAudioAtHostMs"] = (time.monotonic() - synthesis_start) * 1000
                pcm = resample(audio, event["sampleRate"])
                break
            else:
                raise ProbeError("unexpected_synthesis_event")
        if len(pcm) / 32000 + .6 > 14:
            raise ProbeError("fixture_exceeds_utterance_bound")
        child.send("begin", "capture", installAssets=install_assets)
        ready = child.next(time.monotonic() + (125 if install_assets else 20))
        if ready.get("event") != "ready" or ready.get("requestId") != "capture":
            raise ProbeError("capture_not_ready")
        report["captureReadyAtHostMs"] = (time.monotonic() - started) * 1000
        partials = []
        utterance = pcm + bytes(19200)  # 600ms silence belongs to measured VAD-equivalent interval.
        play_start = time.monotonic()
        speech_end = play_start + len(pcm) / 32000
        for sequence, offset in enumerate(range(0, len(utterance), 640)):
            # End-of-frame pacing models 20ms captured PCM delivery, rather than a batch upload.
            frame = utterance[offset:offset + 640]
            due = play_start + (offset + len(frame)) / 32000
            time.sleep(max(0, due - time.monotonic()))
            child.send("append", "capture", sequence=sequence, audioBase64=base64.b64encode(frame).decode())
            ack_deadline = time.monotonic() + 3
            while True:
                event = child.next(ack_deadline)
                if event["requestId"] != "capture":
                    raise ProbeError("wrong_request")
                if event["event"] == "partial":
                    partials.append({"atMs": (time.monotonic() - play_start) * 1000, "text": event.get("text", "")})
                elif event["event"] == "appended" and event.get("sequence") == sequence:
                    break
                else:
                    raise ProbeError("unexpected_capture_event")
        sent_end = time.monotonic()
        child.send("end", "capture")
        deadline = sent_end + 12
        while True:
            event = child.next(deadline)
            if event["event"] == "partial":
                partials.append({"atMs": (time.monotonic() - play_start) * 1000, "text": event.get("text", "")})
            elif event["event"] == "final" and event["requestId"] == "capture":
                if event.get("candidateOnly") is not True:
                    raise ProbeError("unverified_final_authority")
                transcript = event.get("text", "")
                accuracy = difflib.SequenceMatcher(a=normalized(SENTENCE), b=normalized(transcript)).ratio()
                report["stt"] = dict(expected=SENTENCE, transcript=transcript, wordSimilarity=accuracy,
                                     partialEvents=len(partials), partialBeforeEnd=any(p["atMs"] < (sent_end-play_start)*1000 and p["text"] for p in partials),
                                     helperEndToFinalMs=event.get("endToFinalMs"),
                                     syntheticSpeechEndToCandidateAtHostMs=(time.monotonic()-speech_end)*1000,
                                     nativeReceiptVerified=False, microphoneMeasured=False)
                report["helperProbePassed"] = accuracy >= .85 and bool(report["stt"]["partialBeforeEnd"])
                break
            else:
                raise ProbeError("unexpected_final_event")
    finally:
        child.close()
        report["ownedProcessRemaining"] = child.child.poll() is None
        report["durationMs"] = (time.monotonic() - started) * 1000


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--install-assets", action="store_true")
    args = parser.parse_args()
    report = dict(schema="workjet.speech.helper-probe.v1",
                  at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  binary=str(args.binary.resolve()), host=os.uname().nodename,
                  passInstalledRoom=False, helperProbePassed=False,
                  measurement="Helper-only synthetic on-device German TTS->pacedPCM STT; no microphone/room/signing/native receipt claim")
    try:
        run(args.binary.resolve(), report, args.install_assets)
    except Exception as error:
        report["failure"] = str(error) if isinstance(error, ProbeError) else type(error).__name__
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(args.output), "helperProbePassed": report["helperProbePassed"],
                      "failure": report.get("failure"), "passInstalledRoom": False}))
    return 0 if report["helperProbePassed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
