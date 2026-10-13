#!/usr/bin/env python3
"""User-session main deployment controller; no credential or UI access.

Deployment effects remain in the configured, reviewed single-writer adapters.
The launchd entry runs one bounded check, never a polling loop. Activation and
adoption of a measured rollback baseline belong to the supervising operator.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile

REPOSITORY = "metric-space-ai/workjet"
SHA = re.compile(r"^[0-9a-f]{40}$")
UTC = dt.timezone.utc


class Refused(Exception):
    def __init__(self, code, public=None):
        super().__init__(code)
        self.code = code
        self.public = public or {}


def now():
    return dt.datetime.now(UTC)


def instant(value):
    result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise Refused("timestamp_without_timezone")
    return result.astimezone(UTC)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix="." + path.name)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def github_json(route):
    # gh uses its configured official credential provider. No auth values or
    # command output go into evidence; errors are represented by a stable code.
    try:
        result = subprocess.run(["gh", "api", route], capture_output=True,
                                text=True, timeout=30, check=True)
        return json.loads(result.stdout)
    except (subprocess.SubprocessError, ValueError, OSError):
        raise Refused("github_unavailable") from None


def current_main():
    head = github_json("repos/" + REPOSITORY + "/commits/main")["sha"]
    if not isinstance(head, str) or not SHA.fullmatch(head):
        raise Refused("invalid_main_identity")
    return head


def green_ci(head, runs):
    matching = [run for run in runs if run.get("head_sha") == head
                and run.get("head_branch") == "main" and run.get("event") == "push"]
    if not matching:
        raise Refused("main_ci_missing")
    run = max(matching, key=lambda item: (item["run_number"], item.get("run_attempt", 1)))
    identity = {key: run.get(key) for key in
                ("id", "run_number", "run_attempt", "html_url", "head_sha", "status", "conclusion")}
    if run.get("status") != "completed":
        raise Refused("main_ci_pending", {"ci": identity})
    if run.get("conclusion") != "success":
        raise Refused("main_ci_not_green", {"ci": identity})
    return identity


def main_ci(head):
    response = github_json("repos/" + REPOSITORY +
                           "/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100")
    return green_ci(head, response["workflow_runs"])


def required_merges(head, numbers, api=github_json):
    result = []
    for number in numbers:
        if not isinstance(number, int) or isinstance(number, bool) or number < 1:
            raise Refused("required_pull_request_invalid")
        pr = api("repos/" + REPOSITORY + "/pulls/" + str(number))
        if (pr.get("merged") is not True or pr.get("base", {}).get("ref") != "main"
                or pr.get("base", {}).get("repo", {}).get("full_name") != REPOSITORY):
            raise Refused("required_pull_request_not_merged", {"pendingPullRequest": number})
        merge = pr.get("merge_commit_sha", "")
        if not SHA.fullmatch(merge):
            raise Refused("required_pull_request_invalid")
        comparison = api("repos/" + REPOSITORY + "/compare/" + merge + "..." + head)
        if comparison.get("status") not in ("ahead", "identical"):
            raise Refused("main_missing_required_merge")
        result.append({"number": number, "mergeCommit": merge})
    return result


def calendar_gate(snapshot, expected, at):
    if snapshot.get("complete") is not True:
        raise Refused("calendar_incomplete")
    generated, valid = instant(snapshot["generatedAt"]), instant(snapshot["validUntil"])
    if generated > at or valid <= at or at - generated > dt.timedelta(hours=6):
        raise Refused("calendar_stale")
    expected = set(expected)
    if not expected or set(snapshot.get("projectIds", [])) != expected:
        raise Refused("calendar_project_scope_mismatch")
    occurrences = snapshot.get("nextMeetings")
    if not isinstance(occurrences, list):
        raise Refused("calendar_invalid")
    covered = set()
    blocked = []
    for meeting in occurrences:
        project = meeting["projectId"]
        if project not in expected:
            raise Refused("calendar_project_scope_mismatch")
        start = instant(meeting["startsAt"])
        end = instant(meeting["endsAt"]) if meeting.get("endsAt") else start
        if end < start:
            raise Refused("calendar_invalid")
        if end >= at:
            covered.add(project)
        # Include the ongoing meeting, not only its preceding two hours.
        if start - dt.timedelta(hours=2) <= at <= end:
            blocked.append({"projectId": project, "startsAt": start.isoformat()})
    if covered != expected:
        raise Refused("calendar_missing_next_meeting")
    if blocked:
        raise Refused("meeting_installation_blackout")
    return {"generatedAt": generated.isoformat(), "validUntil": valid.isoformat(),
            "projectCount": len(expected)}


def startup_pass(proof):
    elapsed = proof.get("firstSuccessfulProjectListMs")
    return (proof.get("appStarted") is True and proof.get("serviceActive") is True
            and proof.get("normalRestart") is True and proof.get("prepareGuestCount") == 1
            and isinstance(elapsed, (int, float)) and not isinstance(elapsed, bool)
            and 0 <= elapsed < 10000 and proof.get("invariantErrors") == 0)


def baseline_receipt(path, installed_asar):
    receipt = json.loads(Path(path).read_text())
    if (receipt.get("phase") != "accepted" or receipt.get("pass") is not True
            or not startup_pass(receipt.get("measured", {}))):
        raise Refused("rollback_baseline_not_measured_green")
    artifact = receipt["artifact"]
    if (not SHA.fullmatch(receipt.get("source", ""))
            or digest(artifact["signedZip"]) != artifact["signedZipSha256"]):
        raise Refused("rollback_artifact_mismatch")
    if digest(installed_asar) != artifact["asarSha256"]:
        raise Refused("installed_app_changed")
    return receipt


def checked_command(config, phase):
    adapter = config.get("adapters", {}).get(phase)
    if not isinstance(adapter, dict):
        raise Refused("deployment_adapter_missing_" + phase)
    script = Path(adapter["script"])
    if not script.is_absolute() or digest(script) != adapter["sha256"]:
        raise Refused("deployment_adapter_identity_mismatch")
    interpreter = adapter["interpreter"]
    if not Path(interpreter).is_absolute():
        raise Refused("deployment_adapter_interpreter_not_absolute")
    return [interpreter, str(script)]


def invoke_adapter(config, phase, context_path, result_path, gated=True):
    args = checked_command(config, phase) + [str(context_path), str(result_path)]
    if gated:
        args = ["greppy", "bash-smart", "--", config["python"], config["macGate"],
                "--owner", config["owner"], "--project", "workjet",
                "--task", "workjet-main-auto-install", "--"] + args
    # Adapters must own bounded work and orderly recovery. Only this captured
    # controller PID receives TERM on timeout; service trees are never signaled.
    child = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
    try:
        code = child.wait(timeout=3600)
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        child.send_signal(signal.SIGTERM)
        try:
            child.wait(timeout=450)
        except subprocess.TimeoutExpired:
            raise Refused("deployment_adapter_recovery_pending", {
                "remainingOwned": [{"pid": child.pid, "phase": phase,
                                    "purpose": "adapter must finish its bounded orderly recovery"}]}) from None
        raise Refused("deployment_adapter_interrupted") from None
    if code == 75:
        raise Refused("resource_admission_deferred")
    if code != 0:
        raise Refused("deployment_adapter_failed_" + phase)
    result = json.loads(Path(result_path).read_text())
    context = json.loads(Path(context_path).read_text())
    if result.get("source") != context["source"] or result.get("terminal") is not True:
        raise Refused("deployment_adapter_receipt_mismatch")
    return result


def execute(config, head, evidence, state_path, api_main=current_main, api_ci=main_ci,
            adapter=invoke_adapter, clock=now, api_merges=required_merges):
    record = {"source": head, "repository": REPOSITORY, "phase": "checking",
              "startedAt": clock().isoformat(), "pass": False, "steps": [],
              "protectedFilesRead": False, "keychainOperations": False,
              "uiClicks": False, "loginPerformed": False}
    receipt = evidence / (head + ".json")
    history = []
    if receipt.exists():
        previous = json.loads(receipt.read_text())
        history = previous.get("attemptHistory", []) + [{key: previous.get(key) for key in
            ("phase", "reason", "ci", "startedAt", "finishedAt", "pass")}]
    record["attemptHistory"] = history
    atomic_json(receipt, record)
    installation_started = False
    try:
        record["ci"] = api_ci(head)
        record["requiredPullRequests"] = api_merges(head, config.get("afterPullRequests", []))
        if config.get("enabled") is not True:
            raise Refused("activation_requires_supervisor_review")
        if api_main() != head:
            raise Refused("main_superseded")
        calendar_gate(json.loads(Path(config["calendarSnapshot"]).read_text()),
                      config["projectIds"], clock())
        baseline = baseline_receipt(config["lastGreenReceipt"], config["installedAsar"])
        # Resolve every effect adapter before beginning a build.
        for phase in ("prepare", "build", "install", "verify", "rollback", "notify"):
            checked_command(config, phase)
        context_path = evidence / (head + "-context.json")
        # Build version is supplied by the approved source producer, then bound
        # to this exact head in all platform manifests. No source version PR.
        context = {"source": head, "buildSuffix": "+" + head[:7],
                   "baselineReceipt": config["lastGreenReceipt"],
                   "evidenceDirectory": str(evidence), "owner": config["owner"]}
        atomic_json(context_path, context)
        # Linux compilation and portable-server preparation finish on the lane
        # before the separate Mac packaging/signing admission is requested.
        record["phase"] = "preparing"
        atomic_json(receipt, record)
        adapter(config, "prepare", context_path,
                evidence / (head + "-prepare.json"), gated=False)
        context["preparedReceipt"] = str(evidence / (head + "-prepare.json"))
        atomic_json(context_path, context)
        record["phase"] = "building"
        atomic_json(receipt, record)
        build = adapter(config, "build", context_path, evidence / (head + "-build.json"))

        artifact = build["artifact"]
        if (artifact.get("signatureVerified") is not True
                or digest(artifact["signedZip"]) != artifact["signedZipSha256"]
                or not artifact["buildVersion"].endswith("+" + head[:7])):
            raise Refused("signed_candidate_not_verified")
        record["artifact"] = artifact
        context["artifact"] = artifact
        atomic_json(context_path, context)
        atomic_json(receipt, record)
        # Recheck after the potentially long build, immediately before restart.
        if api_main() != head:
            raise Refused("main_superseded")
        api_ci(head)
        calendar_gate(json.loads(Path(config["calendarSnapshot"]).read_text()),
                      config["projectIds"], clock())
        baseline_receipt(config["lastGreenReceipt"], config["installedAsar"])
        record["phase"] = "installing"
        atomic_json(receipt, record)
        installation_started = True
        adapter(config, "install", context_path, evidence / (head + "-install.json"))
        verify = adapter(config, "verify", context_path,
                         evidence / (head + "-verify.json"), gated=False)
        measured = verify["measured"]
        record["measured"] = {key: measured.get(key) for key in
                              ("appStarted", "serviceActive", "normalRestart", "prepareGuestCount",
                               "firstSuccessfulProjectListMs", "invariantErrors")}
        if (digest(config["installedAsar"]) != artifact["asarSha256"]
                or verify.get("sourceVerified") is not True
                or not startup_pass(measured)):
            raise Refused("installed_self_check_failed")
        record.update(phase="accepted", **{"pass": True})
        atomic_json(receipt, record)
        atomic_json(state_path, {"lastGreenReceipt": str(receipt), "source": head})
        return record
    except Exception as error:
        code = error.code if isinstance(error, Refused) else "deployment_receipt_unavailable"
        if isinstance(error, Refused):
            record.update(error.public)
        record["reason"] = code
        record["phase"] = "deferred" if code in (
            "main_ci_missing", "main_ci_pending", "resource_admission_deferred",
            "main_superseded", "meeting_installation_blackout",
            "required_pull_request_not_merged") else "refused"
        # An exit75 from the gate guarantees the install adapter never ran.
        if code == "deployment_adapter_recovery_pending":
            # Never start a second writer while the first one's recovery runs.
            record["phase"] = "recovery_required"
        elif installation_started and code != "resource_admission_deferred":
            record["phase"] = "rolling_back"
            atomic_json(receipt, record)
            try:
                rollback = adapter(config, "rollback", context_path,
                                   evidence / (head + "-rollback.json"))
                if (rollback.get("normalRestart") is not True
                        or rollback.get("appStarted") is not True
                        or rollback.get("serviceActive") is not True
                        or digest(config["installedAsar"]) != baseline["artifact"]["asarSha256"]):
                    raise Refused("rollback_readback_failed")
                record["phase"] = "rolled_back"
                atomic_json(state_path, {"lastGreenReceipt": config["lastGreenReceipt"],
                                         "source": baseline["source"]})
            except (Refused, OSError, ValueError, KeyError):
                record["phase"] = "recovery_required"
            atomic_json(receipt, record)
            # Notification receives only source and error code in the context.
            context["failure"] = {"reason": code, "phase": record["phase"]}
            atomic_json(context_path, context)
            try:
                adapter(config, "notify", context_path, evidence / (head + "-notify.json"), gated=False)
            except (Refused, OSError, ValueError, KeyError):
                record["notificationFailed"] = True
        return record
    finally:
        record["finishedAt"] = clock().isoformat()
        atomic_json(receipt, record)


@contextlib.contextmanager
def exclusive(path):
    with Path(path).open("a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("controller_already_running") from None
        yield


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    config_path = Path(args.config).resolve()
    config = json.loads(config_path.read_text())
    if config_path.stat().st_uid != os.getuid() or config_path.stat().st_mode & 0o077:
        raise Refused("config_must_be_owned_private")
    if Path.home() != Path(config["userHome"]) or os.environ.get("WORKJET_HOME"):
        raise Refused("user_home_override_refused")
    evidence = Path(config["evidenceDirectory"])
    evidence.mkdir(parents=True, exist_ok=True, mode=0o700)
    with exclusive(evidence / ".controller.lock"):
        head = current_main()
        existing = evidence / (head + ".json")
        if existing.exists():
            previous = json.loads(existing.read_text())
            if (previous.get("phase") not in ("checking", "deferred", "refused")
                    or previous.get("reason", "").startswith("deployment_adapter_failed_")):

                print(json.dumps({"source": head, "phase": previous["phase"], "changed": False}))
                return
        state_path = evidence / "state.json"
        if state_path.exists():
            config["lastGreenReceipt"] = json.loads(state_path.read_text())["lastGreenReceipt"]
        record = execute(config, head, evidence, state_path)
        print(json.dumps({key: record.get(key) for key in ("source", "phase", "reason", "pass")}))


if __name__ == "__main__":
    try:
        main()
    except (Refused, OSError, ValueError, KeyError) as error:
        print(json.dumps({"phase": "refused", "reason": error.code if isinstance(error, Refused)
                          else "controller_configuration_unavailable", "pass": False}))
        sys.exit(1)
