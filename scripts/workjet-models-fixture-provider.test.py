"""CLI-only tests for the bounded provider used by native Quit acceptance."""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import shutil
import socket
import struct
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from urllib.parse import urlsplit

OWNER = '01a0879f-e692-7361-858c-036208dc53f7'
SCRIPT = Path(__file__).with_name('workjet-models-fixture-provider.py')


class HeldProviderTest(unittest.TestCase):
    def setUp(self):
        base = Path(os.environ['TMPDIR']).resolve()
        self.assertTrue(base.is_relative_to('/Volumes/tmp/dev-artifacts/workjet'))
        self.temporary = tempfile.TemporaryDirectory(prefix='held-provider-test-', dir=base)
        self.output = Path(self.temporary.name) / 'provider'
        self.log = (Path(self.temporary.name) / 'provider.log').open('w')
        self.process = subprocess.Popen(
            [sys.executable, str(SCRIPT), '--owner', OWNER, '--output', str(self.output),
             '--seconds', '20', '--hold-result', '801', '--hold-timeout-seconds',
             '2' if self._testMethodName == 'test_unreleased_reply_times_out' else '8'],
            stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
        self.addCleanup(self.cleanup)
        self.initial = self.wait_for(lambda row: row.get('phase') == 'ready')
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.addCleanup(self.pool.shutdown)

    def cleanup(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        self.log.close()
        evidence = Path(os.environ['TMPDIR']) / 'evidence' / self._testMethodName
        evidence.mkdir(parents=True, exist_ok=True)
        for source in [Path(self.temporary.name) / 'provider.log', self.output / 'receipt.json', self.output / 'requests.jsonl']:
            if source.exists():
                shutil.copy2(source, evidence / source.name)
        (evidence / 'cleanup.json').write_text(json.dumps(dict(pid=self.process.pid, terminal=self.process.poll() is not None, exit_code=self.process.returncode)))
        self.temporary.cleanup()

    def wait_for(self, predicate):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            self.assertIsNone(self.process.poll(), 'Owned fixture exited early')
            try:
                row = json.loads((self.output / 'receipt.json').read_text())
            except (OSError, ValueError):
                row = {}
            if predicate(row):
                return row
            time.sleep(.025)
        self.fail('Fixture did not reach the expected bounded state')

    def request(self, route, question, stream=False):
        payload = dict(model='gpt-6.1-sol', stream=stream,
                       messages=[dict(role='user', content=question)])
        request = urllib.request.Request(
            self.initial['endpoint'] + route, data=json.dumps(payload).encode(),
            headers={'Authorization': 'Bearer fixture-primary-not-a-real-key-p001',
                     'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=12) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()

    def release(self, number, owner=OWNER):
        (self.output / 'release-reply.json').write_text(json.dumps(dict(owner=owner, number=number)))

    def check_held_delivery(self, route, stream):
        immediate = self.request(route, 'What is 297 + 306?', stream)
        self.assertEqual(immediate[0], 200)
        self.assertIn('603', immediate[1])
        future = self.pool.submit(self.request, route, 'What is 125 + 676?', stream)
        waiting = self.wait_for(lambda row: row.get('held_reply', {}).get('phase') == 'waiting')
        held = waiting['held_reply']
        self.assertEqual(waiting['held_request_count'], 1)
        self.assertEqual(held['number'], 2)
        self.release(held['number'], owner='another-owner')
        time.sleep(.1)
        self.assertFalse(future.done(), 'Another owner must not release this request: ' + str(future.result() if future.done() else 'pending'))
        self.release(held['number'] + 1)
        time.sleep(.1)
        self.assertFalse(future.done(), 'Another request must not release this request: ' + str(future.result() if future.done() else 'pending'))
        self.release(held['number'])
        status, body = future.result(timeout=3)
        self.assertEqual(status, 200)
        self.assertIn('801', body)
        delivered = self.wait_for(lambda row: row.get('held_reply', {}).get('phase') == 'delivered')
        self.assertEqual(delivered['requests'], 2)
        self.assertEqual(delivered['held_request_count'], 1)
        self.assertLessEqual(held['accepted_unix'], delivered['held_reply']['released_unix'])
        self.assertLessEqual(delivered['held_reply']['released_unix'], delivered['held_reply']['finished_unix'])
        journal = (self.output / 'requests.jsonl').read_text()
        self.assertNotIn('What is', journal)
        self.assertNotIn('fixture-primary-not-a-real-key', journal)

    def test_responses_json(self):
        self.check_held_delivery('/responses', False)

    def test_responses_stream(self):
        self.check_held_delivery('/responses', True)

    def test_chat_stream(self):
        self.check_held_delivery('/chat/completions', True)

    def test_closed_client_is_not_recorded_as_delivered(self):
        endpoint = urlsplit(self.initial['endpoint'])
        connection = socket.create_connection((endpoint.hostname, endpoint.port), timeout=3)
        self.addCleanup(connection.close)
        payload = json.dumps(dict(model='gpt-6.1-sol', stream=True,
                                  messages=[dict(role='user', content='What is 125 + 676?')])).encode()
        headers = ('POST /v1/responses HTTP/1.1\r\nHost: localhost\r\n'
                   'Authorization: Bearer fixture-primary-not-a-real-key-p001\r\n'
                   'Content-Type: application/json\r\nContent-Length: ' + str(len(payload)) + '\r\n\r\n').encode()
        connection.sendall(headers + payload)
        waiting = self.wait_for(lambda row: row.get('held_reply', {}).get('phase') == 'waiting')
        connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
        connection.close()
        self.release(waiting['held_reply']['number'])
        failed = self.wait_for(lambda row: row.get('held_reply', {}).get('phase') == 'delivery-failed')
        self.assertIn(failed['held_reply']['error_type'], ('BrokenPipeError', 'ConnectionResetError'))
        self.assertEqual(failed['held_request_count'], 1)

    def test_unreleased_reply_times_out(self):
        status, body = self.request('/responses', 'What is 125 + 676?')
        self.assertEqual(status, 504)
        self.assertIn('deadline', body)
        receipt = self.wait_for(lambda row: row.get('held_reply', {}).get('phase') == 'timed-out')
        self.assertNotIn('released_unix', receipt['held_reply'])
        self.assertEqual(receipt['held_request_count'], 1)


if __name__ == '__main__':
    unittest.main()
