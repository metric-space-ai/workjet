#!/usr/bin/env python3
"""Bounded child-protocol checks; status does not run or download a speech model."""
import json
import pathlib
import subprocess
import sys

binary = pathlib.Path(sys.argv[1]).resolve()
scope = dict(protocolVersion=1, command="status", requestId="status",
             instanceId="isolated-models", projectId="p", meetingId="m", deckRevision=1)


def line(value):
    return json.dumps(value).encode() + b"\n"


def invoke(data):
    result = subprocess.run([str(binary)], input=data, capture_output=True, timeout=20)
    assert result.returncode == 0, "child protocol failed"
    assert len(result.stdout) <= 32768, "output bound"
    events = [json.loads(row) for row in result.stdout.splitlines()]
    assert all(len(row) <= 16384 for row in result.stdout.splitlines()), "line bound"
    return events


events = invoke(line(scope) + line(dict(scope, instanceId="foreign", requestId="wrong")))
assert len(events) == 2 and events[0]["event"] == "status"
assert events[0]["instanceId"] == scope["instanceId"]
assert events[1]["event"] == "error" and events[1]["code"] == "scope_mismatch"
assert events[1]["requestId"] == "wrong" and events[1]["instanceId"] == "foreign"
caps = events[0]["capabilities"]
assert all(isinstance(caps[name], bool) for name in ("available", "germanSupported", "germanInstalled"))
assert caps["audioProcessedOnDevice"] is True
assert all(voice["quality"] in ("enhanced", "premium") for voice in caps["germanVoices"])

events = invoke(line(dict(scope, protocolVersion=2)))
assert len(events) == 1 and events[0]["event"] == "protocol_error"
assert events[0]["code"] == "invalid_request" and "instanceId" not in events[0]
events = invoke(b"x" * 16385)
assert len(events) == 1 and events[0]["code"] == "overflow"
events = invoke(json.dumps(scope).encode())  # EOF before newline cannot execute a command.
assert len(events) == 1 and events[0]["event"] == "protocol_error"

child = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL)
try:
    child.stdout.close()
    child.stdin.write(line(scope))
    child.stdin.close()
    assert child.wait(timeout=20) == 74, "broken owner pipe must terminate only the helper"
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)
print("Scoped child status, malformed input, overflow, truncated EOF and broken stdout passed")
