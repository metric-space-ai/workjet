"""Real Linux namespace/IPC integration; no provider/account or installed policy claim."""
import http.server
import json
import os
import pathlib
import shlex
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

helper = pathlib.Path(sys.argv[1]).resolve(strict=True)
base = pathlib.Path(tempfile.mkdtemp(prefix="wj-bridge-", dir=os.environ["TMPDIR"]))
workspace = base / "assigned"
workspace.mkdir()
secret = base / "outside-fixture"
secret.write_text("isolated-fixture-only")
marker = base / "must-not-start"
endpoint = base / "model.sock"
source_events = []
source_finished = []
port = 23197

class Source(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        source_events.append((self.path, self.headers.get("x-api-key")))
        if self.headers.get("x-api-key") != "scoped-fixture":
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for sequence in range(5):
            self.wfile.write(("data: " + str(sequence) + "\n\n").encode())
            self.wfile.flush()
            time.sleep(0.15)
        source_finished.append(time.monotonic())
    def log_message(self, *_args):
        pass

class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

server = Server(str(endpoint), Source)
os.chmod(endpoint, 0o600)
source_thread = threading.Thread(target=server.serve_forever, daemon=True)
source_thread.start()
sentinel = socket.socket()
sentinel.bind(("127.0.0.1", 0))
sentinel.listen(1)
sentinel_port = sentinel.getsockname()[1]
socket_stat = endpoint.stat()
parent_network = pathlib.Path("/proc/self/ns/net").stat()
identity = [str(socket_stat.st_dev), str(socket_stat.st_ino), str(port),
            str(parent_network.st_dev), str(parent_network.st_ino)]

def isolated(command):
    return ["/usr/bin/bwrap", "--die-with-parent", "--new-session",
            "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-uts", "--unshare-ipc",
            "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
            "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
            "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
            "--ro-bind", str(helper), "/run/workjet/helper",
            "--ro-bind", str(endpoint), "/run/workjet/model.sock",
            "--bind", str(workspace), str(workspace), "--chdir", str(workspace),
            "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp/home",
            "--remount-ro", "/", "--", *command]

def bridge(arguments, command):
    return ["/run/workjet/helper", "--worker-model-bridge",
            "/run/workjet/model.sock", *arguments, "--", *command]

def run(command, **options):
    return subprocess.run(isolated(command), capture_output=True, text=True, timeout=20, **options)

result = {"schema": "workjet.model_namespace_bridge.integration.v1", "installedAcceptance": False}
process = None
watchdog = None
try:
    denied = subprocess.run([str(helper), "--worker-model-bridge", str(endpoint),
                            *identity, "--", "/bin/sh", "-c",
                            "printf forbidden > " + shlex.quote(str(marker))],
                            capture_output=True, text=True, timeout=5)
    assert denied.returncode != 0 and "not isolated" in denied.stderr
    assert not marker.exists()
    wrong = list(identity)
    wrong[1] = str(socket_stat.st_ino + 1)
    rejected = run(bridge(wrong, ["/bin/sh", "-c", "printf forbidden > " + shlex.quote(str(marker))]))
    assert rejected.returncode != 0 and "identity changed" in rejected.stderr
    assert not marker.exists()

    child = 'set -eu; read -r input; test "$input" = owned-stdin; ' \
            'curl --fail --silent --show-error --no-buffer -H "x-api-key: scoped-fixture" ' \
            f'http://127.0.0.1:{port}/v1/stream; ' \
            'printf edited > inside.txt; test ! -e ' + shlex.quote(str(secret)) + '; ' \
            f'if curl --silent --max-time 1 http://127.0.0.1:{sentinel_port}/outside >/tmp/outside 2>/dev/null; then exit 91; fi; ' \
            'test "$(curl --silent -o /tmp/denied -w "%{http_code}" -H "x-api-key: wrong" ' \
            f'http://127.0.0.1:{port}/v1/stream)" = 403'
    process = subprocess.Popen(isolated(bridge(identity, ["/bin/sh", "-c", child])),
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    watchdog = threading.Timer(20, process.kill)
    watchdog.daemon = True
    watchdog.start()
    process.stdin.write("owned-stdin\n")
    process.stdin.close()
    frames = []
    first_received = None
    for line in process.stdout:
        if line.startswith("data: "):
            if first_received is None:
                first_received = time.monotonic()
            frames.append(line.strip())
    stderr = process.stderr.read()
    assert process.wait(timeout=10) == 0, stderr
    assert frames == ["data: " + str(sequence) for sequence in range(5)]
    assert source_finished and first_received < source_finished[0]
    assert (workspace / "inside.txt").read_text() == "edited"
    assert secret.read_text() == "isolated-fixture-only"
    assert source_events == [("/v1/stream", "scoped-fixture"), ("/v1/stream", "wrong")]
    bounded_probe = """import socket,time
first = socket.create_connection(("127.0.0.1", 23197), timeout=2)
time.sleep(0.1)
second = socket.create_connection(("127.0.0.1", 23197), timeout=2)
time.sleep(0.1)
try:
    third = socket.create_connection(("127.0.0.1", 23197), timeout=2)
    try:
        third.sendall(b"GET /v1/stream HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n")
        assert b"503 Service Unavailable" in third.recv(4096)
    finally:
        third.close()
finally:
    first.close()
    second.close()
"""
    limited = run(bridge(identity, ["/usr/bin/python3", "-c", bounded_probe]))
    assert limited.returncode == 0, limited.stderr
    exited = run(bridge(identity, ["/bin/sh", "-c", "exit 23"]))
    assert exited.returncode == 23
    failed = run(bridge(identity, ["/missing-worker"]))
    assert failed.returncode != 0
    result.update(passComponent=True, hostNetworkRejected=True, replacedSocketRejected=True,
                  stdinForwarded=True, framesUnchanged=True, firstFrameBeforeSourceCompletion=True,
                  scopedHeadersPreserved=True, deniedKeyPreserved=True, outsideTCPDenied=True,
                  outsideFileInvisible=True, workspaceEditSucceeded=True, childExitCodePreserved=True,
                  spawnFailureTerminal=True, connectionsCapped=True, fixturesRemoved=True)
    print("MODEL_NAMESPACE_BRIDGE " + json.dumps(result))
finally:
    if watchdog is not None:
        watchdog.cancel()
        watchdog.join(timeout=1)
    if process is not None and process.poll() is None:
        process.kill()
        process.wait(timeout=5)
    sentinel.close()
    server.shutdown()
    server.server_close()
    source_thread.join(timeout=2)
    shutil.rmtree(base)
