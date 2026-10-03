"""Bounded loopback HTTP fixture for native gateway and visible Workjet stories."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import signal
import time
from urllib.parse import urlsplit

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--owner', required=True)
parser.add_argument('--seconds', type=int, default=900)
args = parser.parse_args()
root = Path(args.output)
allowed = Path('/Volumes/tmp/dev-artifacts/workjet')
if not root.is_absolute() or not root.resolve().is_relative_to(allowed) or root.resolve() == allowed:
    raise SystemExit('Fixture output must be a task-owned absolute tmp-volume path')
if not Path('/Volumes/tmp').is_mount() or not 1 <= args.seconds <= 900:
    raise SystemExit('Mounted tmp volume and a bounded <=900s fixture are required')
root.mkdir(parents=True, exist_ok=False)
os.chmod(root, 0o700)
started = time.time()
keys = {
    'fixture-primary-not-a-real-key-p001',
    'fixture-secondary-not-a-real-key-s002',
    'fixture-other-not-a-real-key-o003',
}
record = dict(schema='workjet.models.local-provider-fixture.v1', owner=args.owner,
              pid=os.getpid(), process_group=os.getpgrp(), purpose='Sanitized loopback inference fixture',
              output=str(root), started_unix=started, deadline_unix=started + args.seconds,
              stop_condition='SIGTERM or <=900s wall deadline; at most 200 accepted inference requests',
              requests=0, terminal=False)

def save():
    (root / 'receipt.json').write_text(json.dumps(record, indent=2) + '\n')

def user_text(body):
    def text(value):
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return ' '.join(text(part) for part in value)
        if isinstance(value, dict):
            return text(value.get('text', value.get('content', '')))
        return ''
    source = body.get('messages', body.get('input', ''))
    if isinstance(source, list):
        source = [item for item in source if isinstance(item, dict) and item.get('role') == 'user']
    return text(source)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *values):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(3)

    def send_json(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if urlsplit(self.path).path == '/v1/models':
            self.send_json(200, dict(object='list', data=[dict(id=model, object='model', owned_by='local-fixture') for model in ['fixture-model-before', 'fixture-model-one', 'fixture-model-two', 'fixture-shared-model']]))
        else:
            self.send_json(404, dict(error=dict(message='Local fixture route unavailable')))

    def do_POST(self):
        if record['requests'] >= 200:
            self.send_json(429, dict(error=dict(message='Local fixture request bound reached')))
            return
        route = urlsplit(self.path).path
        if route not in ('/v1/chat/completions', '/v1/responses'):
            self.send_json(404, dict(error=dict(message='Local fixture route unavailable')))
            return
        authorization = self.headers.get('Authorization', '')
        if authorization.removeprefix('Bearer ') not in keys:
            self.send_json(401, dict(error=dict(message='Synthetic fixture credentials rejected', code='invalid_api_key')))
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 65536:
                raise ValueError()
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError()
        except (ValueError, OSError):
            self.send_json(400, dict(error=dict(message='Invalid bounded fixture request')))
            return
        question = re.search(r'\bWhat is\s+(\d{1,12})\s*\+\s*(\d{1,12})\s*\?', user_text(body))
        reply = str(int(question[1]) + int(question[2])) if question else 'fixture reply'
        model = 'fixture-shared-model'
        record['requests'] += 1
        number = record['requests']
        identity = 'fixture-response-' + str(number)
        receipt = dict(number=number, route=route, status=200, model=model, streamed=body.get('stream') is True, observed_unix=time.time())
        # No authorization value, request body, prompt or raw session/cache identity is recorded.
        session = body.get('prompt_cache_key', body.get('session_id'))
        if isinstance(session, str):
            receipt['affinity_fingerprint'] = hashlib.sha256(session.encode()).hexdigest()
        with (root / 'requests.jsonl').open('a') as journal:
            journal.write(json.dumps(receipt) + '\n')
        save()
        response = dict(id=identity, object='response', status='completed', model=model,
                        output=[dict(id='fixture-message-' + str(number), type='message', role='assistant', status='completed', content=[dict(type='output_text', text=reply, annotations=[])])])
        if body.get('stream') is not True:
            self.send_json(200, response if route.endswith('/responses') else dict(id=identity, object='chat.completion', created=int(time.time()), model=model, choices=[dict(index=0, message=dict(role='assistant', content=reply), finish_reason='stop')]))
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.end_headers()
        if route.endswith('/responses'):
            item = response['output'][0]
            events = [
                dict(type='response.created', response={**response, 'status':'in_progress', 'output':[]}),
                dict(type='response.output_item.added', output_index=0, item={**item, 'status':'in_progress', 'content':[]}),
                dict(type='response.content_part.added', item_id=item['id'], output_index=0, content_index=0, part=dict(type='output_text', text='', annotations=[])),
                dict(type='response.output_text.delta', item_id=item['id'], output_index=0, content_index=0, delta=reply),
                dict(type='response.output_text.done', item_id=item['id'], output_index=0, content_index=0, text=reply),
                dict(type='response.content_part.done', item_id=item['id'], output_index=0, content_index=0, part=item['content'][0]),
                dict(type='response.output_item.done', output_index=0, item=item),
                dict(type='response.completed', response=response),
            ]
            for sequence, event in enumerate(events):
                event['sequence_number'] = sequence
                self.wfile.write(('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n').encode())
        else:
            for delta, finish in [(dict(role='assistant', content=''), None), (dict(content=reply), None), ({}, 'stop')]:
                event = dict(id=identity, object='chat.completion.chunk', created=int(time.time()), model=model, choices=[dict(index=0, delta=delta, finish_reason=finish)])
                self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
        # Usage is absent because this deterministic fixture does not measure model tokens.
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()
        self.close_connection = True

server = HTTPServer(('127.0.0.1', 0), Handler)
record.update(endpoint='http://127.0.0.1:' + str(server.server_port) + '/v1', phase='ready')
save()
print('LOCAL_PROVIDER_READY ' + json.dumps({key:record[key] for key in ('owner','pid','endpoint','output','deadline_unix')}), flush=True)

def stop(signum, frame):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGALRM, stop)
signal.alarm(args.seconds)
try:
    server.serve_forever(poll_interval=0.2)
finally:
    server.server_close()
    record.update(terminal=True, phase='stopped', finished_unix=time.time())
    save()
