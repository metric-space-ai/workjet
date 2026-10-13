import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import datetime as dt

spec = importlib.util.spec_from_file_location("main_auto_install", Path(__file__).with_name("main-auto-install.py"))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
HEAD = "a" * 40
OLD = "b" * 40
AT = dt.datetime(2026, 10, 14, 9, 0, tzinfo=dt.timezone.utc)


def ci(**fields):
    return {"id": 4, "run_number": 8, "run_attempt": 1, "head_sha": HEAD,
            "head_branch": "main", "event": "push", "status": "completed",
            "conclusion": "success", **fields}


def measured(**fields):
    return {"appStarted": True, "serviceActive": True, "normalRestart": True,
            "prepareGuestCount": 1, "firstSuccessfulProjectListMs": 9999,
            "invariantErrors": 0, **fields}


def calendar(**fields):
    return {"complete": True, "generatedAt": (AT - dt.timedelta(minutes=1)).isoformat(),
            "validUntil": (AT + dt.timedelta(hours=5)).isoformat(), "projectIds": ["molecularity"],
            "nextMeetings": [{"projectId": "molecularity", "startsAt": "2026-10-14T13:00:00+02:00",
                              "endsAt": "2026-10-14T14:00:00+02:00"}], **fields}


class Gates(unittest.TestCase):
    def test_prior_green_cannot_hide_current_retry_failure(self):
        with self.assertRaisesRegex(agent.Refused, "main_ci_not_green"):
            agent.green_ci(HEAD, [ci(), ci(run_attempt=2, conclusion="failure")])

    def test_pr_green_and_different_head_do_not_qualify_main(self):
        with self.assertRaisesRegex(agent.Refused, "main_ci_missing"):
            agent.green_ci(HEAD, [ci(event="pull_request"), ci(head_sha=OLD)])

    def test_old_green_main_cannot_replace_a_newer_integration(self):
        with self.assertRaisesRegex(agent.Refused, "not_merged"):
            agent.required_merges(HEAD, [608], api=lambda _: {"merged": False})
        responses = iter([{"merged": True, "base": {"ref": "main", "repo": {
            "full_name": agent.REPOSITORY}}, "merge_commit_sha": OLD}, {"status": "diverged"}])
        with self.assertRaisesRegex(agent.Refused, "missing_required_merge"):
            agent.required_merges(HEAD, [608], api=lambda _: next(responses))

    def test_squash_merge_identity_is_supported(self):
        responses = iter([{"merged": True, "base": {"ref": "main", "repo": {
            "full_name": agent.REPOSITORY}}, "merge_commit_sha": OLD}, {"status": "ahead"}])
        self.assertEqual(agent.required_merges(HEAD, [608], api=lambda _: next(responses)),
                         [{"number": 608, "mergeCommit": OLD}])

    def test_queued_main_is_not_green(self):

        with self.assertRaisesRegex(agent.Refused, "main_ci_pending"):
            agent.green_ci(HEAD, [ci(status="queued", conclusion=None)])

    def test_exact_two_hour_boundary_and_ongoing_meeting_are_blocked(self):
        for at in (AT, AT + dt.timedelta(hours=2), AT + dt.timedelta(hours=3)):
            with self.subTest(at=at), self.assertRaisesRegex(agent.Refused, "blackout"):
                agent.calendar_gate(calendar(), ["molecularity"], at)
        agent.calendar_gate(calendar(), ["molecularity"], AT - dt.timedelta(seconds=1))

    def test_missing_or_stale_schedule_fails_closed(self):
        for snapshot, reason in [(calendar(complete=False), "incomplete"),
                                 (calendar(nextMeetings=[]), "missing_next_meeting"),
                                 (calendar(validUntil=AT.isoformat()), "stale")]:
            with self.subTest(reason=reason), self.assertRaisesRegex(agent.Refused, reason):
                agent.calendar_gate(snapshot, ["molecularity"], AT)

    def test_calendar_cannot_forget_a_project_or_accept_naive_time(self):
        with self.assertRaisesRegex(agent.Refused, "scope_mismatch"):
            agent.calendar_gate(calendar(), ["molecularity", "flylabs"], AT)
        with self.assertRaisesRegex(agent.Refused, "without_timezone"):
            agent.instant("2026-10-14T13:00:00")

    def test_startup_requires_one_guest_and_completion_before_ten_seconds(self):
        self.assertTrue(agent.startup_pass(measured()))
        for changes in ({"firstSuccessfulProjectListMs": 10000}, {"prepareGuestCount": 0},
                        {"prepareGuestCount": 2}, {"firstSuccessfulProjectListMs": True},
                        {"appStarted": False}, {"serviceActive": False}, {"normalRestart": False},
                        {"invariantErrors": 1}):
            with self.subTest(changes=changes):
                self.assertFalse(agent.startup_pass(measured(**changes)))


class Deployment(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.asar = self.root / "app.asar"
        self.asar.write_bytes(b"previous verified app")
        self.zip = self.root / "old-signed.zip"
        self.zip.write_bytes(b"old artifact fixture")
        self.base = self.root / "baseline.json"
        self.old_artifact = {"signedZip": str(self.zip), "signedZipSha256": agent.digest(self.zip),
                             "asarSha256": agent.digest(self.asar), "buildVersion": "0.0.96+" + OLD[:7]}
        agent.atomic_json(self.base, {"source": OLD, "phase": "accepted", "pass": True,
                                     "measured": measured(), "artifact": self.old_artifact})
        self.cal = self.root / "calendar.json"
        agent.atomic_json(self.cal, calendar())
        driver = self.root / "approved-driver.py"
        driver.write_text("# immutable test adapter\n")
        self.config = {"enabled": True, "calendarSnapshot": str(self.cal), "projectIds": ["molecularity"],
                       "lastGreenReceipt": str(self.base), "installedAsar": str(self.asar),
                       "owner": "test-owner", "adapters": {phase: {"script": str(driver),
                       "sha256": agent.digest(driver), "interpreter": sys.executable} for phase in
                       ("prepare", "build", "install", "verify", "rollback", "notify")}}
        self.calls = []
        self.new_zip = self.root / "new-signed.zip"
        self.new_zip.write_bytes(b"new artifact fixture")
        self.artifact = {"signatureVerified": True, "signedZip": str(self.new_zip),
                         "signedZipSha256": agent.digest(self.new_zip),
                         "asarSha256": __import__("hashlib").sha256(b"new app").hexdigest(),
                         "buildVersion": "0.0.96+" + HEAD[:7]}
        self.state = self.root / "state.json"
        self.proof = measured()

    def run_agent(self, api_main=lambda: HEAD, api_ci=lambda head: ci(), adapter=None):
        return agent.execute(self.config, HEAD, self.root, self.state,
                             api_main=api_main, api_ci=api_ci, adapter=adapter or self.adapter,
                             clock=lambda: AT - dt.timedelta(seconds=2))

    def adapter(self, config, phase, context, result, gated=True):
        self.calls.append(phase)
        if phase == "build":
            return {"artifact": self.artifact}
        if phase == "install":
            self.asar.write_bytes(b"new app")
        if phase == "verify":
            return {"sourceVerified": True, "measured": self.proof}
        if phase == "rollback":
            self.asar.write_bytes(b"previous verified app")
            return {"normalRestart": True, "appStarted": True, "serviceActive": True}
        return {}

    def test_pending_ci_never_calls_effect_adapter(self):
        def pending(_):
            raise agent.Refused("main_ci_pending")
        result = self.run_agent(api_ci=pending)
        self.assertEqual(result["phase"], "deferred")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.asar.read_bytes(), b"previous verified app")

    def test_superseded_during_build_preserves_install(self):
        heads = iter([HEAD, OLD])
        result = self.run_agent(api_main=lambda: next(heads))
        self.assertEqual(result["reason"], "main_superseded")
        self.assertEqual(self.calls, ["prepare", "build"])
        self.assertEqual(self.asar.read_bytes(), b"previous verified app")

    def test_meeting_that_starts_during_build_prevents_restart(self):
        def changing(config, phase, context, result, gated=True):
            answer = self.adapter(config, phase, context, result, gated)
            if phase == "build":
                agent.atomic_json(self.cal, calendar(nextMeetings=[{
                    "projectId": "molecularity", "startsAt": (AT + dt.timedelta(minutes=20)).isoformat()}]))
            return answer
        result = self.run_agent(adapter=changing)
        self.assertEqual(result["reason"], "meeting_installation_blackout")
        self.assertNotIn("install", self.calls)

    def test_bad_startup_rolls_back_once_and_never_adopts_candidate(self):
        self.proof = measured(firstSuccessfulProjectListMs=117630)
        result = self.run_agent()
        self.assertEqual(result["phase"], "rolled_back")
        self.assertEqual(self.calls, ["prepare", "build", "install", "verify", "rollback", "notify"])
        self.assertEqual(json.loads(self.state.read_text())["source"], OLD)
        self.assertEqual(self.asar.read_bytes(), b"previous verified app")
        self.assertFalse(result["pass"])

    def test_malformed_post_install_receipt_also_rolls_back(self):
        def malformed(config, phase, context, result, gated=True):
            if phase == "verify":
                raise ValueError("malformed private result, not copied to evidence")
            return self.adapter(config, phase, context, result, gated)
        result = self.run_agent(adapter=malformed)
        self.assertEqual(result["phase"], "rolled_back")
        self.assertEqual(result["reason"], "deployment_receipt_unavailable")
        self.assertEqual(self.asar.read_bytes(), b"previous verified app")

    def test_foreign_app_after_install_is_not_replaced_by_rollback(self):
        def changed(config, phase, context, result, gated=True):
            answer = self.adapter(config, phase, context, result, gated)
            if phase == "verify":
                self.asar.write_bytes(b"foreign update")
            return answer
        result = self.run_agent(adapter=changed)
        self.assertEqual(result["phase"], "recovery_required")
        self.assertNotIn("rollback", self.calls)
        self.assertEqual(self.asar.read_bytes(), b"foreign update")

    def test_uncertain_recovery_never_starts_a_second_writer(self):

        def pending(config, phase, context, result, gated=True):
            if phase == "install":
                self.calls.append(phase)
                raise agent.Refused("deployment_adapter_recovery_pending", {"remainingOwned": [{"pid": 123}]})
            return self.adapter(config, phase, context, result, gated)
        result = self.run_agent(adapter=pending)
        self.assertEqual(result["phase"], "recovery_required")
        self.assertNotIn("rollback", self.calls)
        self.assertEqual(result["remainingOwned"], [{"pid": 123}])

    def test_success_is_only_adopted_after_installed_readback(self):

        result = self.run_agent()
        self.assertTrue(result["pass"])
        self.assertEqual(result["phase"], "accepted")
        self.assertEqual(json.loads(self.state.read_text())["source"], HEAD)
        self.assertNotIn("rollback", self.calls)

    def test_reconsidering_a_deferred_head_preserves_its_negative_evidence(self):
        def pending(_):
            raise agent.Refused("main_ci_pending")
        self.run_agent(api_ci=pending)
        accepted = self.run_agent()
        self.assertTrue(accepted["pass"])
        self.assertEqual(accepted["attemptHistory"][0]["reason"], "main_ci_pending")
        self.assertFalse(accepted["attemptHistory"][0]["pass"])

    def test_foreign_install_is_never_overwritten(self):

        self.asar.write_bytes(b"some other owner's install")
        result = self.run_agent()
        self.assertEqual(result["reason"], "installed_app_changed")
        self.assertEqual(self.calls, [])

    def test_missing_rollback_adapter_is_detected_before_build(self):
        del self.config["adapters"]["rollback"]
        result = self.run_agent()
        self.assertEqual(result["reason"], "deployment_adapter_missing_rollback")
        self.assertEqual(self.calls, [])

    def test_atomic_receipt_is_private_and_lock_is_exclusive(self):
        self.run_agent()
        self.assertEqual((self.root / (HEAD + ".json")).stat().st_mode & 0o077, 0)
        with agent.exclusive(self.root / "lock"):
            with self.assertRaisesRegex(agent.Refused, "already_running"):
                with agent.exclusive(self.root / "lock"):
                    self.fail("overlap accepted")


if __name__ == "__main__":
    unittest.main()
