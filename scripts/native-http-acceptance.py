#!/usr/bin/env python3
"""Bounded native HTTP fixture; invoke only through the shared heavy-job gate."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import socket
import subprocess
import time

OWNER = "01a0879f-e692-7361-858c-036208dc53f7"
ROOT = Path(__file__).resolve().parent.parent
BASE = Path("/Volumes/tmp/dev-artifacts/workjet/pr73-http-acceptance")
DURABLE = Path("/Users/michaelwelsch/.codex/task-evidence/workjet/pr73-current-desktop-20260930")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workjet-source", required=True)
    parser.add_argument("--native-source", required=True)
    parser.add_argument("--native-workjet-pin", required=True)
    parser.add_argument("--native-receipt", type=Path, required=True)
    args = parser.parse_args()
    start = time.monotonic()
    deadline = start + 600
    processes = []
    output = None
    saved = None
    server = None
    report = {"owner": OWNER, "controller_pid": os.getpid(), "controller_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "source": args.workjet_source, "native_source": args.native_source, "native_workjet_pin": args.native_workjet_pin, "scope": "Isolated local mcp:local operator, actual native HTTP plus Workjet client/file-backed ledger. No GUI, managed human identity, providers, WebRTC or installed acceptance.", "deadline_seconds": 600, "stages": [], "passed": False, "terminal": False}

    def budget(limit):
        remaining = min(limit, deadline - time.monotonic())
        assert remaining > 0, "Owned fixture deadline"
        return remaining

    def save():
        if saved:
            (saved / "receipt.json").write_text(json.dumps(report, indent=2) + "\n")

    def members(group):
        rows = subprocess.check_output(["ps", "-axo", "pid=,pgid="], text=True, timeout=5).splitlines()
        return [int(row.split()[0]) for row in rows if row.split() and int(row.split()[1]) == group]

    def stop(child, row):
        if members(child.pid):
            os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
        if members(child.pid):
            os.killpg(child.pid, signal.SIGKILL)
        row["remaining_group_members"] = members(child.pid)
        assert not row["remaining_group_members"], "Owned group remains"
        row["terminal"] = True
        save()

    def run(label, argv, limit=30, cwd=ROOT, private=None, execution_env=None):
        row = {"stage": label, "deadline_seconds": limit}
        report["stages"].append(row)
        stdout = private or output / (label + ".stdout")
        stderr = output / (label + ".stderr")
        with stdout.open("wb") as out, stderr.open("wb") as err:
            stdout.chmod(0o600)
            stderr.chmod(0o600)
            child = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True, env=execution_env)
            row.update(pid=child.pid, process_group=child.pid)
            processes.append((child, row))
            save()
            try:
                row["exit_code"] = child.wait(timeout=budget(limit))
            finally:
                stop(child, row)
        assert row["exit_code"] == 0, "Owned stage failed"
        assert stdout.stat().st_size <= 262144 and stderr.stat().st_size <= 262144, "Owned output limit"
        print(label + ": exit 0", flush=True)
        return stdout

    def interrupted(signum, frame):
        raise TimeoutError("Owned fixture interrupted")

    def checksum(path):
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1048576), b""):
                budget(1)
                digest.update(chunk)
        return digest.hexdigest()

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(600)
    private_files = []
    native_root = None
    try:
        assert Path(os.environ["TMPDIR"]).resolve().is_relative_to("/Volumes/tmp")
        os.environ.update(NODE_OPTIONS="--max-old-space-size=4096", GOMAXPROCS="2", RAYON_NUM_THREADS="2")
        gate = json.loads(subprocess.check_output(["/usr/bin/python3", "/Users/michaelwelsch/.codex/bin/dev-heavy-run.py", "--status"], text=True, timeout=10))
        lease = json.loads(gate["lease_owner"])
        assert gate["lease_busy"] and lease["owner"] == OWNER and lease["project"] == "workjet", "Actual own heavy lease required"
        assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, timeout=10).strip() == args.workjet_source
        assert not subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True, timeout=10).strip()
        producer = json.loads(args.native_receipt.read_text())
        assert producer["state"]["head"] == args.native_source
        assert producer["binding"]["revision"] == args.native_workjet_pin
        assert producer["state"]["tracked_diff_sha256"] == hashlib.sha256(b"").hexdigest()
        assert producer["state"]["untracked_sha256"] == hashlib.sha256(b"[]").hexdigest()
        native_checkout = Path(producer["root"]).resolve()
        assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=native_checkout, text=True, timeout=10).strip() == args.native_source
        assert not subprocess.check_output(["git", "status", "--porcelain"], cwd=native_checkout, text=True, timeout=10).strip()
        binary = Path(producer["executable"]).resolve()
        assert binary.is_relative_to("/Volumes/tmp/dev-artifacts/ctox")
        assert checksum(binary) == producer["sha256"], "Producer executable hash mismatch"
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        output = BASE / stamp
        output.mkdir(parents=True, mode=0o700)
        os.environ["NODE_COMPILE_CACHE"] = str(output / "node-compile-cache")
        saved = DURABLE / ("native-http-acceptance-" + stamp)
        saved.mkdir(mode=0o700)
        report.update(output=str(output), binary=str(binary), binary_sha256=producer["sha256"], producer_receipt_sha256=checksum(args.native_receipt), started_at=stamp)
        save()
        native_root = output / "native-root"
        run("01-source-clone", ["git", "clone", "--shared", "--no-checkout", str(native_checkout), str(native_root)], 120)
        run("02-source-checkout", ["git", "checkout", "--detach", args.native_source], 120, native_root)

        native_env = {**os.environ, "CTOX_ROOT": str(native_root), "CTOX_STATE_ROOT": str(native_root / "runtime")}
        def native(label, command, private=None):
            return run(label, [str(binary), *command, "--root", str(native_root)], private=private, execution_env=native_env)

        # Fresh roots need the native canonical schema bootstrap before domain commands.
        # A missing or rejected init is terminal; never synthesize tables or domain rows.
        native("02-native-schema", ["business-os", "rxdb", "init"])

        def authority(label, role):
            invite = output / (label + "-invite.json")
            private_files.append(invite)
            receipt_file = native(label, ["business-os", "desktop", "invite", "--user", "mcp:local", "--role", role, "--ttl-hours", "1", "--output", str(invite)])
            private_files.append(receipt_file)
            receipt = json.loads(receipt_file.read_text())
            invite.chmod(0o600)
            assert receipt["ok"] is True, "Native fixture authority rejected"
            invite.unlink()

        authority("03-owner-admin", "admin")
        project = "workjet-http-project-" + stamp.lower()
        upsert = {"id": "workjet-http-create-" + stamp.lower(), "module": "ctox", "command_type": "ctox.workjet.project.upsert", "payload": {"project_id": project, "name": "Isolated HTTP acceptance"}, "client_context": {"actor": {"id": "mcp:local", "role": "admin", "is_admin": True}}}
        created = json.loads(native("04-native-project", ["business-os", "commands", "dispatch", "--json", json.dumps(upsert, separators=(",", ":"))]).read_text())
        assert created.get("ok") is not False
        native("05-native-policy", ["business-os", "mcp", "policy", "set", "--enabled", "true", "--allow-reads", "true", "--allow-writes", "true", "--allow-actor", "mcp:local", "--allow-workspace", "local"])
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        endpoint = "http://127.0.0.1:" + str(port) + "/mcp"
        server_row = {"stage": "06-owned-http-server", "endpoint": endpoint, "stop_condition": "Always at fixture terminal; entire unit600s"}
        server_err_path = output / "server.stderr"
        with server_err_path.open("wb") as server_err:
            server_err_path.chmod(0o600)
            server = subprocess.Popen([str(binary), "business-os", "mcp", "serve", "--addr", "127.0.0.1:" + str(port), "--root", str(native_root)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=server_err, start_new_session=True, env=native_env)
            server_row.update(pid=server.pid, process_group=server.pid)
            processes.append((server, server_row))
            report["stages"].append(server_row)
            save()
            # Await the real server's emitted bound/provisioned readiness line, not a sleep or retry loop.
            with selectors.DefaultSelector() as selector:
                selector.register(server.stdout, selectors.EVENT_READ)
                assert selector.select(timeout=budget(20)), "Native readiness output missing"
                line = server.stdout.readline(4096)
                assert line.decode().strip() == "CTOX Business OS MCP listening on http://127.0.0.1:" + str(port), "Native HTTP server did not signal ready"
            token_file = output / "private-token.json"
            private_files.append(token_file)
            native("07-private-token", ["secret", "get", "--scope", "business_os", "--name", "mcp_inbound_auth_token"], private=token_file)
            assert isinstance(json.loads(token_file.read_text())["value"], str)
            fixture_file = output / "private-fixture.json"
            private_files.append(fixture_file)
            fixture = {"workjetSource": args.workjet_source, "nativeSource": args.native_source, "nativeWorkjetPin": args.native_workjet_pin, "nativeBinarySha256": producer["sha256"], "serverPid": server.pid, "directory": str(output), "nativeRoot": str(native_root), "endpoint": endpoint, "tokenFile": str(token_file), "scope": {"threadId": "workjet-http-thread-" + stamp.lower(), "connectionId": "workjet-http-connection-" + stamp.lower(), "instanceId": "workjet-http-instance-" + stamp.lower()}, "requestId": "workjet-http-turn-" + stamp.lower(), "projectTask": {"project_id": project, "title": "Isolated durable native HTTP task", "instruction": "Keep this queued task across a lost response and fresh Workjet processes; no provider execution requested."}, "cancelKey": "workjet-http-cancel-" + stamp.lower()}
            fixture_file.write_text(json.dumps(fixture))
            fixture_file.chmod(0o600)
            for phase in ("first", "resume", "revoked", "stop", "verify"):
                if phase == "revoked":
                    authority("08-revoke-real-role", "user")
                if phase == "stop":
                    authority("09-restore-real-role", "admin")
                run("workjet-" + phase, [shutil.which("node"), str(ROOT / "apps/server/src/workjet/ctox/tests/native-http-acceptance.ts"), str(fixture_file), phase], 90)
                result = json.loads((output / ("workjet-" + phase + "-result.json")).read_text())
                assert result["status"] == "passed" and result["phase"] == phase
                allowed = {key: result[key] for key in ("status", "phase", "workjetSource", "nativeSource", "nativeWorkjetPin", "nativeBinarySha256", "httpCalls", "nativeKey", "localRequestRows", "commandId", "taskId", "scopeLimit")}
                (saved / ("workjet-" + phase + "-result.json")).write_text(json.dumps(allowed, indent=2) + "\n")
            assert checksum(binary) == producer["sha256"], "Producer binary changed during fixture"
            assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, timeout=10).strip() == args.workjet_source
            assert not subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True, timeout=10).strip()
            report["passed"] = True
    except BaseException as error:
        # Private native/HTTP output remains only in the owned tmp fixture. Never emit raw errors/secrets.
        report["failure_class"] = type(error).__name__
        report["failed_stage"] = report["stages"][-1]["stage"] if report["stages"] else "preflight"
    finally:
        signal.alarm(0)
        for child, row in reversed(processes):
            try:
                stop(child, row)
            except BaseException:
                report["passed"] = False
                report["cleanup_failed"] = True
        for private in private_files:
            private.unlink(missing_ok=True)
        report.update(terminal=True, seconds=round(time.monotonic() - start, 3), remaining_owned_processes=[pid for child, _ in processes for pid in members(child.pid)], private_plaintext_credentials_removed=True)
        if output and not report["remaining_owned_processes"] and not report.get("cleanup_failed"):
            if native_root and native_root.exists():
                # This is our disposable shared clone, not another task's worktree; native runtime is ignored.
                clean = not subprocess.check_output(["git", "status", "--porcelain"], cwd=native_root, text=True, timeout=10).strip()
                head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=native_root, text=True, timeout=10).strip()
                if clean and head == args.native_source:
                    shutil.rmtree(native_root)
                    report["native_fixture_removed"] = True
                else:
                    report["cleanup_failed"] = True
                    report["passed"] = False
            report["private_tmp_logs_retained"] = str(output)
        save()
        print(json.dumps({"passed": report["passed"], "terminal": True, "receipt": str(saved / "receipt.json") if saved else None, "failure_class": report.get("failure_class"), "remaining_owned_processes": report["remaining_owned_processes"]}), flush=True)
    return 0 if report["passed"] and not report["remaining_owned_processes"] and not report.get("cleanup_failed") else 1


if __name__ == "__main__":
    raise SystemExit(main())
