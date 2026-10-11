#!/usr/bin/env python3
"""Bounded Linux process proof; no real provider/account/model or installed G2 claim."""
import copy
import http.server
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

helper = pathlib.Path(sys.argv[1]).resolve()
root = pathlib.Path(tempfile.mkdtemp(prefix="workjet-namespace-launch-", dir=os.environ["TMPDIR"]))
workspace = root / "worker"
profile = root / "profile"
runtime = root / "runtime"
for path in (workspace, profile, runtime):
    path.mkdir(mode=0o700)
(profile / "home").mkdir(mode=0o700)
outside = root / "host-secret"
outside.write_text("outside-fixture")
outside_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
source_done = threading.Event()

class Source(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer scoped-fixture":
            self.send_response(403); self.end_headers(); return
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        for i in range(5):
            self.wfile.write(("data: " + str(i) + "\n\n").encode()); self.wfile.flush(); time.sleep(0.15)
        source_done.set()
    def log_message(self, *_args):
        pass

class UnixHTTP(http.server.HTTPServer):
    address_family = socket.AF_UNIX

socket_path = root / "model.sock"
server = UnixHTTP(str(socket_path), Source)
os.chmod(socket_path, 0o600)
serving = threading.Thread(target=server.serve_forever, daemon=True)
serving.start()
sentinel = http.server.HTTPServer(("127.0.0.1", 0), Source)
sentinel_thread = threading.Thread(target=sentinel.serve_forever, daemon=True)
sentinel_thread.start()

def identity(path):
    stat = path.stat()
    return {"device": str(stat.st_dev), "inode": str(stat.st_ino)}

def cap(path):
    return {"path": str(path), "identity": identity(path)}

def run(command, **options):
    return subprocess.run(command, text=True, capture_output=True, timeout=25, **options)

worker_file = runtime / "worker.py"
worker_file.write_text("""
import errno, http.client, json, os, pathlib, socket, stat, subprocess, sys, time
workspace, outside, port, compiler = sys.argv[1:]
assert pathlib.Path.cwd() == pathlib.Path(workspace)
assert sys.stdin.readline().strip() == "owned-stdin"
assert "HOST_UNRELATED_SECRET" not in os.environ
assert "GIT_CONFIG_COUNT" not in os.environ
assert os.environ["TMPDIR"] == "/tmp"
assert not pathlib.Path(outside).exists()
assert not pathlib.Path(outside).parent.joinpath("model.sock").exists()
try:
    pathlib.Path(__file__).with_name("immutable-asset").write_text("must-not-write")
except OSError: pass
else: raise AssertionError("runtime bundle is writable")
leaked = []
for name in os.listdir("/proc/self/fd"):
    fd = int(name)
    if fd < 3: continue
    try:
        if stat.S_ISDIR(os.fstat(fd).st_mode): leaked.append(fd)
    except OSError: pass
assert not leaked, leaked
try:
    socket.create_connection(("127.0.0.1", int(port)), timeout=1)
except OSError: pass
else: raise AssertionError("host TCP escaped namespace")
pathlib.Path("worker-edit").write_text("edited")
pathlib.Path(os.environ["HOME"]).joinpath("session-state").write_text("owned-private-state")
pathlib.Path("main.c").write_text("int main(void) { return 0; }")
subprocess.run([compiler, "main.c", "-o", "worker-build"], check=True)
subprocess.run(["./worker-build"], check=True)
subprocess.run(["/usr/bin/git", "add", "worker-edit", "main.c"], check=True)
subprocess.run(["/usr/bin/git", "commit", "-m", "owned worker result"], check=True, stdout=subprocess.DEVNULL)
connection = http.client.HTTPConnection("127.0.0.1", 23197, timeout=3)
connection.request("GET", "/v1/responses", headers={"Authorization": "Bearer scoped-fixture"})
response = connection.getresponse()
assert response.status == 200
frames = []
for i in range(5):
    line = response.fp.readline()
    frames.append(line.decode().strip())
    assert response.fp.readline() == b"\\n"
    if i == 0:
        print("FIRST_FRAME " + str(time.monotonic()), flush=True)
assert frames == ["data: " + str(i) for i in range(5)], frames
connection.close()
print("WORKER_NAMESPACE_RESULT " + json.dumps({"streamed": True, "directoryDescriptorsAbsent": True, "outsideFileInvisible": True, "outsideTCPDenied": True, "compiled": True, "committed": True, "profileStateWritten": True}), flush=True)
sys.exit(23)
""")
plan = {
    "version": 1, "worktree": cap(workspace),
    "gitIdentity": {}, "profile": cap(profile), "modelSocket": cap(socket_path),
    "hostNetwork": identity(pathlib.Path("/proc/self/ns/net")),
    "runtimeFiles": [cap(worker_file)],
    "runtimeDirectories": [cap(runtime)],
}
compiler = pathlib.Path(shutil.which("cc")).resolve()
environment = {"PATH": "/usr/bin:/bin", "HOME": str(profile / "home"), "WORKJET_SOURCE_ISOLATED": "true",
               "HOST_UNRELATED_SECRET": "must-not-reach-worker", "GIT_CONFIG_COUNT": "100"}
process = None
try:
    for args in (["init"], ["config", "user.name", "Workjet fixture"], ["config", "user.email", "fixture@invalid"]):
        result = run(["git", "-C", str(workspace), *args])
        assert result.returncode == 0, result.stderr
    plan["gitIdentity"] = identity(workspace / ".git")
    command = [str(helper), "--worker-namespace-launch", json.dumps(plan), "--",
               str(pathlib.Path(sys.executable).resolve()), str(worker_file), str(workspace), str(outside),
               str(sentinel.server_port), str(compiler)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, env=environment, pass_fds=(outside_fd,))
    watchdog = threading.Timer(25, process.kill); watchdog.start()
    try:
        process.stdin.write("owned-stdin\n"); process.stdin.close()
        first = process.stdout.readline()
        assert first.startswith("FIRST_FRAME "), (first, process.stderr.read())
        assert not source_done.is_set(), "stream was buffered to source completion"
        output = process.stdout.read()
        error = process.stderr.read()
        assert process.wait(timeout=5) == 23, error
        assert "WORKER_NAMESPACE_RESULT " in output, (output, error)
    finally:
        watchdog.cancel()
    assert outside.read_text() == "outside-fixture"
    assert (profile / "home/session-state").read_text() == "owned-private-state"
    assert (workspace / "worker-edit").read_text() == "edited"
    assert identity(workspace / ".git") == plan["gitIdentity"]

    def rejected(changed):
        marker = workspace / "must-not-start"
        result = run([str(helper), "--worker-namespace-launch", json.dumps(changed), "--",
                      "/usr/bin/touch", str(marker)], env=environment, pass_fds=(outside_fd,))
        assert result.returncode != 0, result
        assert not marker.exists(), result
        return result.stderr
    changed = copy.deepcopy(plan); changed["worktree"]["identity"]["inode"] = "0"
    assert "identity changed" in rejected(changed)
    changed = copy.deepcopy(plan); changed["gitIdentity"]["inode"] = "0"
    assert "Git identity changed" in rejected(changed)
    changed = copy.deepcopy(plan); changed["modelSocket"]["identity"]["inode"] = "0"
    assert "socket identity changed" in rejected(changed)
    alias = root / "alias"; alias.symlink_to(root, target_is_directory=True)
    changed = copy.deepcopy(plan); changed["worktree"]["path"] = str(alias / "worker")
    rejected(changed)
    (workspace / ".git/objects/info/alternates").write_text(str(root / "foreign-objects"))
    assert "shared Git metadata" in rejected(plan)
    (workspace / ".git/objects/info/alternates").unlink()
    changed = copy.deepcopy(plan); changed["runtimeFiles"][0]["identity"]["inode"] = "0"
    assert "runtime file identity changed" in rejected(changed)
    changed = copy.deepcopy(plan); changed["runtimeDirectories"][0]["identity"]["inode"] = "0"
    assert "directory identity changed" in rejected(changed)
    print("WORKER_NAMESPACE_LAUNCH " + json.dumps({
        "schema": "workjet.worker_namespace_launch.integration.v1", "installedAcceptance": False,
        "passComponent": True, "originalCwdKept": True, "privateGitCommitted": True,
        "compiledAndExecuted": True, "headersAndFramesPreserved": True,
        "firstFrameBeforeCompletion": True, "childExitPreserved": True, "stdinKept": True,
        "hostFileAndTCPDenied": True, "inheritedDirectoryFDClosed": True, "mountFDsClosed": True,
        "targetEnvironmentSecretRemoved": True, "profileStatePreserved": True,
        "runtimeBundleReadonly": True,
        "badWorkspaceGitSocketRuntimeIdentitiesRejected": True, "symlinkAncestorRejected": True,
        "gitAlternatesRejected": True, "realProviderAccountModel": False
    }))
finally:
    if process is not None and process.poll() is None:
        process.kill(); process.wait(timeout=5)
    os.close(outside_fd)
    server.shutdown(); server.server_close(); serving.join(timeout=2)
    sentinel.shutdown(); sentinel.server_close(); sentinel_thread.join(timeout=2)
    shutil.rmtree(root)
