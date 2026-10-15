#!/usr/bin/env python3
"""Read-only installed startup adapter. No requests, login, UI or secret reads."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

UTC = dt.timezone.utc
APP = Path("/Applications/Workjet.app")
LOGS = Path.home() / ".workjet/userdata/logs"
TRACE_NAME = re.compile(r"^desktop\.trace\.ndjson(?:\.\d+)?$")


def collect_startup(logs, opened):
    cutoff = int(opened.timestamp() * 1_000_000_000)
    seen = set()
    guests, projects, invariants = [], [], 0
    for path in logs.iterdir():
        if not TRACE_NAME.fullmatch(path.name) or path.is_symlink() or path.stat().st_mtime < opened.timestamp():
            continue
        with path.open() as stream:
            for line in stream:
                try:
                    event = json.loads(line)
                    start = int(event.get("startTimeUnixNano") or event.get("timeUnixNano") or 0)
                except (ValueError, TypeError):
                    continue
                if start < cutoff:
                    continue
                # Inspect in memory; arbitrary messages/attributes are never persisted.
                if "Invariant" in json.dumps(event) or "invariant violation" in json.dumps(event).lower():
                    invariants += 1
                if "startTimeUnixNano" not in event or "endTimeUnixNano" not in event:
                    continue
                identity = event.get("spanId")
                if identity is None or identity in seen:
                    continue
                seen.add(identity)
                try:
                    end = int(event["endTimeUnixNano"])
                except (ValueError, TypeError):
                    continue
                attributes = event.get("attributes") or {}
                if event.get("name") == "CtoxGuestManager.prepareGuest":
                    guests.append(identity)
                if (event.get("name") == "CtoxGuestManager.requestProjectControl"
                        and attributes.get("action") == "project.list"):
                    projects.append({"completedAfterOpenMs": (end - cutoff) / 1_000_000,
                                     "durationMs": (end - start) / 1_000_000,
                                     "outcome": attributes.get("outcome"),
                                     "reason": attributes.get("reason")})
    successful = [p["completedAfterOpenMs"] for p in projects if p["outcome"] == "completed"]
    return {"prepareGuestCount": len(guests),
            "firstSuccessfulProjectListMs": min(successful) if successful else None,
            "invariantErrors": invariants, "projectListCount": len(projects)}


def file_hash(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(data)
    return h.hexdigest()


def main():
    os.umask(0o077)
    context = json.loads(Path(sys.argv[1]).read_text())
    destination = Path(sys.argv[2])
    evidence = Path(context["evidenceDirectory"]).resolve()
    installed = json.loads((evidence / (context["source"] + "-install.json")).read_text())
    opened = dt.datetime.fromisoformat(installed["openedAt"].replace("Z", "+00:00"))
    if opened.tzinfo is None:
        raise ValueError("opened_at_requires_timezone")
    label = installed["serviceLabel"]
    if not re.fullmatch(r"dev\.workjet\.server\.[a-f0-9]{64}", label):
        raise ValueError("service_label_required")
    # Allow bounded telemetry flushing. The measured criterion is still actual
    # project.list completion <10 s, never the time this observer finishes.
    until = time.monotonic() + 60
    while True:
        measured = collect_startup(LOGS, opened)
        if measured["firstSuccessfulProjectListMs"] is not None or time.monotonic() >= until:
            break
        time.sleep(1)
    process = subprocess.run(["/usr/bin/pgrep", "-f",
                              "^/Applications/Workjet.app/Contents/MacOS/Workjet$"],
                             capture_output=True, text=True, timeout=5)
    service = subprocess.run(["/bin/launchctl", "print", "gui/" + str(os.getuid()) + "/" + label],
                             capture_output=True, text=True, timeout=10)
    measured.update(appStarted=process.returncode == 0 and len(process.stdout.split()) == 1,
                    serviceActive=service.returncode == 0 and bool(re.search(
                        r"^\s*state = running$", service.stdout, re.M)),
                    normalRestart=installed.get("normalRestart") is True)
    source = subprocess.run([context["artifact"]["node"], str(Path(__file__).with_name(
        "main-auto-install-verify-public.mjs")), sys.argv[1]], capture_output=True, text=True, timeout=30)
    source_verified = source.returncode == 0 and json.loads(source.stdout).get("sourceVerified") is True
    signature = subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(APP)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    matched = file_hash(APP / "Contents/Resources/app.asar") == context["artifact"]["asarSha256"]
    result = {"source": context["source"], "terminal": True, "measured": measured,
              "sourceVerified": source_verified and matched and signature.returncode == 0,
              "readOnly": True, "forcedRequests": False, "observedAt": dt.datetime.now(UTC).isoformat()}
    destination.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
