#!/usr/bin/env python3
"""Protocol-only fixture; runs inside the real Linux worker namespace."""
import json
import os
import pathlib
import sys

pending = None
responses = set()
turns = 0
session = "namespace-session"

def write(message):
    print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)

for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "initialize":
        capabilities = message["params"]["clientCapabilities"]
        assert capabilities["fs"]["readTextFile"] is False
        assert capabilities["fs"]["writeTextFile"] is False
        assert capabilities["terminal"] is False
        write({"id": message["id"], "result": {
            "protocolVersion": 1, "agentCapabilities": {},
            "authMethods": [{"id": "test", "name": "Test"}]}})
    elif method == "authenticate":
        write({"id": message["id"], "result": {}})
    elif method == "session/new":
        assert pathlib.Path(message["params"]["cwd"]) == pathlib.Path.cwd()
        write({"id": message["id"], "result": {"sessionId": session}})
    elif method == "session/prompt":
        pending = message["id"]
        responses = set()
        for request_id, callback, extra in [
            ("read", "fs/read_text_file", {"path": "/host-secret"}),
            ("write", "fs/write_text_file", {"path": "/host-secret", "content": "forbidden"}),
            ("terminal", "terminal/create", {"command": "/usr/bin/touch", "args": ["/host-secret"]}),
        ]:
            write({"id": request_id, "method": callback, "params": {"sessionId": session, **extra}})
    elif message.get("id") in ("read", "write", "terminal"):
        assert "error" in message, message
        responses.add(message["id"])
        if len(responses) == 3:
            turns += 1
            pathlib.Path(os.environ["HOME"]).joinpath("acp-turns").write_text(str(turns))
            write({"method": "session/update", "params": {
                "sessionId": session, "update": {"sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "Namespace callbacks denied"}}}})
            write({"id": pending, "result": {"stopReason": "end_turn"}})
            pending = None
