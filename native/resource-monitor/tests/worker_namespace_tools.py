#!/usr/bin/env python3
"""Actual Linux namespace file/terminal proof, without live model or Owner-admission claims."""
import copy
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile

helper = pathlib.Path(sys.argv[1]).resolve(strict=True)
root = pathlib.Path(tempfile.mkdtemp(prefix="wj-tools-", dir=os.environ["TMPDIR"]))
workspace = root / "worker"
profile = root / "profile"
workspace.mkdir(mode=0o700)
profile.mkdir(mode=0o700)
(profile / "home").mkdir(mode=0o700)
outside = root / "outside"
outside.write_text("host-only fixture")
directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
source = socket.socket(socket.AF_UNIX)
socket_path = "/proc/" + str(os.getpid()) + "/fd/" + str(directory) + "/s"
source.bind(socket_path)
source.listen(2)
os.chmod(root / "s", 0o600)

def identity(path):
    stat = path.stat()
    return {"device": str(stat.st_dev), "inode": str(stat.st_ino)}

def cap(path):
    return {"path": str(path), "identity": identity(path)}

subprocess.run(["git", "init", str(workspace)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
plan = {
    "version": 1, "worktree": cap(workspace), "gitIdentity": identity(workspace / ".git"),
    "profile": cap(profile), "modelSocket": {"path": socket_path, "identity": identity(root / "s")},
    "hostNetwork": identity(pathlib.Path("/proc/self/ns/net")), "runtimeFiles": [],
}
environment = {"HOME": str(profile / "home"), "PATH": "/usr/bin:/bin", "WORKJET_SOURCE_ISOLATED": "true"}
checks = []

def tool(operation, content=None, succeeds=True, changed=None):
    selected = changed or plan
    request = {"version": 1, "worktree": selected["worktree"], "hostNetwork": plan["hostNetwork"], "operation": operation}
    result = subprocess.run([
        str(helper), "--worker-namespace-launch", json.dumps(selected), "--",
        "/run/workjet/helper", "--worker-namespace-tools", json.dumps(request),
    ], env=environment, input=content, text=True, capture_output=True, timeout=20)
    assert (result.returncode == 0) == succeeds, (operation, result.returncode, result.stderr)
    return result

def read(path, **options):
    return json.loads(tool({"kind": "read", "path": str(path), **options}).stdout)["content"]

try:
    target = workspace / "source.txt"
    tool({"kind": "write", "path": str(target)}, "one\n🙂two\nthree\n")
    assert read(target) == "one\n🙂two\nthree\n"
    assert read(target, line=2, limit=1) == "🙂two\n"
    assert read(target, limit=0) == ""
    tool({"kind": "read", "path": str(target), "line": 0}, succeeds=False)
    checks.append("read-write-and-line-windows")

    link = workspace / "inside-link"
    link.symlink_to("source.txt")
    assert read(link) == read(target)
    escape = workspace / "escape"
    escape.symlink_to(outside)
    tool({"kind": "read", "path": str(escape)}, succeeds=False)
    tool({"kind": "write", "path": str(escape)}, "forbidden", succeeds=False)
    tool({"kind": "read", "path": str(outside)}, succeeds=False)
    tool({"kind": "write", "path": str(profile / "home/foreign")}, "forbidden", succeeds=False)
    tool({"kind": "write", "path": str(workspace / "../outside")}, "forbidden", succeeds=False)
    assert outside.read_text() == "host-only fixture"
    checks.append("foreign-path-profile-and-symlink-denied")

    hardlink = workspace / "hardlink"
    os.link(outside, hardlink)
    tool({"kind": "read", "path": str(hardlink)}, succeeds=False)
    tool({"kind": "write", "path": str(hardlink)}, "owned replacement")
    assert outside.read_text() == "host-only fixture" and hardlink.read_text() == "owned replacement"
    assert hardlink.stat().st_ino != outside.stat().st_ino
    checks.append("hardlink-read-denied-write-replaces-without-foreign-mutation")

    fifo = workspace / "fifo"
    os.mkfifo(fifo)
    tool({"kind": "read", "path": str(fifo)}, succeeds=False)
    tool({"kind": "write", "path": str(fifo)}, "forbidden", succeeds=False)
    too_large = workspace / "large.txt"
    too_large.write_bytes(b"x" * (4 * 1024 * 1024 + 1))
    tool({"kind": "read", "path": str(too_large)}, succeeds=False)
    tool({"kind": "write", "path": str(target)}, "x" * (4 * 1024 * 1024 + 1), succeeds=False)
    assert target.read_text() == "one\n🙂two\nthree\n"
    checks.append("bounded-text-and-special-files-denied")

    result = tool({"kind": "terminal", "command": "/usr/bin/sh", "args": ["-c", "set -e; test ! -e /etc/passwd; printf '%s' \"$OWNED_VALUE\"; printf 'int main(void){return 0;}' >main.c; cc main.c -o tool-build; ./tool-build"],
                   "cwd": str(workspace), "env": {"OWNED_VALUE": "terminal-result"}})
    assert result.stdout == "terminal-result" and (workspace / "tool-build").is_file()
    tool({"kind": "terminal", "command": "/usr/bin/touch", "args": [str(outside)], "cwd": str(workspace), "env": {}}, succeeds=False)
    tool({"kind": "terminal", "command": "/usr/bin/true", "args": [], "cwd": str(profile), "env": {}}, succeeds=False)
    tool({"kind": "terminal", "command": "/usr/bin/true", "args": [], "cwd": str(workspace), "env": {"HOME": str(profile)}}, succeeds=False)
    assert outside.read_text() == "host-only fixture"
    checks.append("ordinary-terminal-build-and-foreign-cwd-env-denied")

    changed = copy.deepcopy(plan)
    changed["worktree"]["identity"]["inode"] = "0"
    tool({"kind": "write", "path": str(target)}, "forbidden", succeeds=False, changed=changed)
    assert target.read_text() == "one\n🙂two\nthree\n"
    original = root / "original-worker"
    workspace.rename(original)
    workspace.mkdir(mode=0o700)
    try:
        tool({"kind": "write", "path": str(target)}, "forbidden", succeeds=False)
        assert not target.exists()
        assert (original / "source.txt").read_text() == "one\n🙂two\nthree\n"
    finally:
        workspace.rmdir()
        original.rename(workspace)
    checks.append("real-worktree-replacement-does-not-adopt-a-new-directory")

    direct = subprocess.run([str(helper), "--worker-namespace-tools", json.dumps({
        "version": 1, "worktree": cap(workspace), "hostNetwork": plan["hostNetwork"],
        "operation": {"kind": "write", "path": str(target)},
    })], env=environment, input="forbidden", text=True, capture_output=True, timeout=5)
    assert direct.returncode != 0 and "original host network" in direct.stderr
    checks.append("original-capture-rechecked-and-direct-host-entry-denied")

    print("WORKER_NAMESPACE_TOOLS " + json.dumps({
        "schema": "workjet.worker_namespace_tools.integration.v1", "checks": checks,
        "passComponent": True, "installedAcceptance": False, "realProviderAccountModel": False,
    }))
finally:
    source.close()
    os.close(directory)
    shutil.rmtree(root)
