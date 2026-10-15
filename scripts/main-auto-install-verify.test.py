import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("verify", Path(__file__).with_name("main-auto-install-verify.py"))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)
OPEN = dt.datetime(2026, 10, 13, 17, 36, 47, tzinfo=dt.timezone.utc)
BASE = int(OPEN.timestamp() * 1_000_000_000)


def span(id, name, start_ms, duration_ms, **attrs):
    return {"spanId": id, "name": name, "startTimeUnixNano": str(BASE + start_ms * 1_000_000),
            "endTimeUnixNano": str(BASE + (start_ms + duration_ms) * 1_000_000), "attributes": attrs}


class Trace(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.logs = Path(self.temp.name)

    def write(self, name, events):
        (self.logs / name).write_text("\n".join(json.dumps(event) for event in events) + "\n")

    def test_rotation_and_log_before_span_preserve_one_guest_and_first_success(self):
        guest = span("guest", "CtoxGuestManager.prepareGuest", 2000, 4000)
        first = span("first", "CtoxGuestManager.requestProjectControl", 6000, 3000,
                     action="project.list", outcome="completed")
        self.write("desktop.trace.ndjson.1", [
            {"spanId": "guest", "timeUnixNano": str(BASE + 2000 * 1_000_000), "name": "log"},
            guest, first])
        self.write("desktop.trace.ndjson", [guest, span("later", "CtoxGuestManager.requestProjectControl",
                   12000, 500, action="project.list", outcome="completed")])
        answer = verify.collect_startup(self.logs, OPEN)
        self.assertEqual(answer["prepareGuestCount"], 1)
        self.assertEqual(answer["firstSuccessfulProjectListMs"], 9000)
        self.assertEqual(answer["projectListCount"], 2)

    def test_request_duration_cannot_substitute_for_elapsed_startup(self):
        self.write("desktop.trace.ndjson", [span("late", "CtoxGuestManager.requestProjectControl",
                   117000, 600, action="project.list", outcome="completed", privateDetail="NOT_FOR_EVIDENCE")])
        answer = verify.collect_startup(self.logs, OPEN)
        self.assertEqual(answer["firstSuccessfulProjectListMs"], 117600)
        self.assertNotIn("NOT_FOR_EVIDENCE", json.dumps(answer))

    def test_timeout_is_not_a_success_and_old_spans_are_excluded(self):
        self.write("desktop.trace.ndjson", [span("old", "CtoxGuestManager.prepareGuest", -30000, 4000),
                   span("failed", "CtoxGuestManager.requestProjectControl", 5000, 29000,
                        action="project.list", outcome="failed", reason="request_timeout")])
        answer = verify.collect_startup(self.logs, OPEN)
        self.assertEqual(answer["prepareGuestCount"], 0)
        self.assertIsNone(answer["firstSuccessfulProjectListMs"])

    def test_unrelated_files_and_symlinks_are_not_read(self):
        self.write("desktop.trace.ndjson.not-a-trace", [span("g", "CtoxGuestManager.prepareGuest", 1, 2)])
        (self.logs / "desktop.trace.ndjson.1").symlink_to(self.logs / "desktop.trace.ndjson.not-a-trace")
        self.assertEqual(verify.collect_startup(self.logs, OPEN)["prepareGuestCount"], 0)


if __name__ == "__main__":
    unittest.main()
