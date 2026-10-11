#!/usr/bin/env python3
"""Protocol-only fixture using real confined client tools; no model/account claim."""
import json
import os
import pathlib
import sys

session = "namespace-session"
turns = 0
request_id = 0
held_terminal = None

def write(message):
    print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)

def call(method, params, succeeds=True, session_id=session):
    global request_id
    request_id += 1
    write({"id": request_id, "method": method, "params": {"sessionId": session_id, **params}})
    reply = json.loads(sys.stdin.readline())
    with pathlib.Path(os.environ["HOME"]).joinpath("acp-tool-replies").open("a") as log:
        log.write(json.dumps({"method": method, "reply": reply}) + "\n")
    assert reply.get("id") == request_id, reply
    assert ("result" in reply) == succeeds, reply
    return reply.get("result")

for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "initialize":
        capabilities = message["params"]["clientCapabilities"]
        assert capabilities["fs"]["readTextFile"] is True
        assert capabilities["fs"]["writeTextFile"] is True
        assert capabilities["terminal"] is True
        write({"id": message["id"], "result": {
            "protocolVersion": 1, "agentCapabilities": {},
            "authMethods": [{"id": "test", "name": "Test"}, {"id": "greppy.env", "name": "Fixture source"}]}})
    elif method == "authenticate":
        write({"id": message["id"], "result": {}})
    elif method == "session/set_model":
        write({"id": message["id"], "result": {}})
    elif method == "session/new":
        assert pathlib.Path(message["params"]["cwd"]) == pathlib.Path.cwd()
        write({"id": message["id"], "result": {"sessionId": session}})
    elif method == "session/prompt":
        turns += 1
        text = " ".join(item.get("text", "") for item in message["params"]["prompt"])
        target = str(pathlib.Path.cwd() / "main.c")
        if "cleanup-only" in text or "source-denied" in text:
            assert held_terminal is not None
            if "cleanup-only" in text:
                call("terminal/kill", {"terminalId": held_terminal})
                call("terminal/release", {"terminalId": held_terminal})
            else:
                call("fs/read_text_file", {"path": target}, False)
                call("fs/write_text_file", {"path": target, "content": "stale-write"}, False)
                call("terminal/create", {"command": "/usr/bin/touch", "args": ["denied-effect"]}, False)
                call("terminal/output", {"terminalId": held_terminal}, False)
                call("terminal/wait_for_exit", {"terminalId": held_terminal}, False)
            write({"method": "session/update", "params": {
                "sessionId": session, "update": {"sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "Cleanup completed" if "cleanup-only" in text
                            else "Source unavailable; confined actions refused"}}}})
            write({"id": message["id"], "result": {"stopReason": "end_turn"}})
            continue
        call("fs/write_text_file", {"path": target, "content": "int main(void) { return 0; }\n"})
        assert call("fs/read_text_file", {"path": target})["content"] == "int main(void) { return 0; }\n"
        assert call("fs/read_text_file", {"path": target, "line": 1, "limit": 1})["content"].endswith("\n")
        call("fs/read_text_file", {"path": "/host-secret"}, False)
        call("fs/write_text_file", {"path": "/host-secret", "content": "forbidden"}, False)
        call("fs/read_text_file", {"path": target}, False, "foreign-session")
        call("terminal/create", {"command": "/usr/bin/true", "cwd": "/foreign"}, False)
        call("terminal/output", {"terminalId": "unknown-host-terminal"}, False)
        shell = (
            "cc main.c -o worker-build && ./worker-build && "
            "git add main.c && git -c user.name=Fixture -c user.email=fixture@invalid "
            "commit --allow-empty -m tool-result-" + str(turns) + " >/dev/null && "
            "/usr/bin/python3 -c \"print('🙂' * 100 + 'terminal-" + str(turns) + "')\""
        )
        terminal = call("terminal/create", {"command": "/usr/bin/sh", "args": ["-c", shell],
                                          "env": [{"name": "FIXTURE_VALUE", "value": "owned"}],
                                          "outputByteLimit": 64})["terminalId"]
        assert call("terminal/wait_for_exit", {"terminalId": terminal})["exitCode"] == 0
        output = call("terminal/output", {"terminalId": terminal})
        assert output["truncated"] is True and output["output"].endswith("terminal-" + str(turns) + "\n"), output
        assert len(output["output"].encode("utf8")) <= 64 and "�" not in output["output"], output
        call("terminal/release", {"terminalId": terminal})
        call("terminal/output", {"terminalId": terminal}, False)
        outside = call("terminal/create", {"command": "/usr/bin/touch", "args": ["/host-secret"]})["terminalId"]
        assert call("terminal/wait_for_exit", {"terminalId": outside})["exitCode"] != 0
        call("terminal/release", {"terminalId": outside})
        sleeping = call("terminal/create", {"command": "/usr/bin/sleep", "args": ["30"]})["terminalId"]
        call("terminal/kill", {"terminalId": sleeping})
        stopped = call("terminal/wait_for_exit", {"terminalId": sleeping})
        assert stopped.get("exitCode", 0) != 0 or stopped.get("signal") in ("SIGTERM", "SIGKILL"), stopped
        call("terminal/release", {"terminalId": sleeping})
        if turns == 2 or "hold-terminal" in text or "hold-turn" in text:
            # Deliberately leave an owned terminal alive for runtime-scope teardown or revocation.
            held_terminal = call("terminal/create", {"command": "/usr/bin/sleep", "args": ["30"]})["terminalId"]
        pathlib.Path(os.environ["HOME"]).joinpath("acp-turns").write_text(str(turns))
        write({"method": "session/update", "params": {
            "sessionId": session, "update": {"sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": "Confined read/edit/build/git and terminal lifecycle completed"}}}})
        if "hold-turn" in text:
            # Keep the actual prompt and an owned terminal pending until Source revocation.
            sys.stdin.readline()
            raise AssertionError("Source revocation should terminate this fixture process")
        write({"id": message["id"], "result": {"stopReason": "end_turn"}})
