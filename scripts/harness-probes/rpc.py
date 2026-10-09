#!/usr/bin/env python3
"""Small NDJSON client. Always owns and terminates only the child it starts."""
import json
import os
import queue
import signal
import subprocess
import threading
import time
from capture import redact


class Rpc:
    def __init__(self, command, cwd, env=None, handler=None):
        self.command = command
        self.child = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      text=True, bufsize=1, start_new_session=True)
        print("owned_child_pid", self.child.pid, flush=True)
        self.events = []
        self.stderr = []
        self.inbox = queue.Queue()
        self.counter = 0
        self.handler = handler
        self.threads = [threading.Thread(target=self._read, daemon=True),
                        threading.Thread(target=self._errors, daemon=True)]
        for thread in self.threads:
            thread.start()

    def _read(self):
        for line in self.child.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                self.events.append({'non_json_stdout': redact(line)})
                continue
            self.events.append({'receive': event})
            if 'method' in event and 'id' in event:
                try:
                    result = self.handler(event) if self.handler else None
                    if result is None:
                        self.send({'jsonrpc':'2.0','id':event['id'],
                                   'error':{'code':-32601,'message':'Probe does not implement this client method'}})
                    else:
                        self.send({'jsonrpc':'2.0','id':event['id'],'result':result})
                except Exception as error:
                    self.send({'jsonrpc':'2.0','id':event['id'],
                               'error':{'code':-32603,'message':str(error)}})
            else:
                self.inbox.put(event)
        self.inbox.put({'process_eof': self.child.poll()})

    def _errors(self):
        for line in self.child.stderr:
            if len(self.stderr) < 200:
                self.stderr.append(redact(line))

    def send(self, event):
        self.events.append({'send':event})
        self.child.stdin.write(json.dumps(event) + '\n')
        self.child.stdin.flush()

    def request(self, method, params=None, timeout=30, pi=False):
        self.counter += 1
        ident = str(self.counter)
        self.send({'id':ident,'type':method,**(params or {})} if pi else
                  {'jsonrpc':'2.0','id':ident,'method':method,'params':params or {}})
        deadline = time.monotonic() + timeout
        while True:
            event = self.inbox.get(timeout=max(0.01,deadline-time.monotonic()))
            if 'process_eof' in event:
                raise RuntimeError('child ended before response: '+str(event))
            if str(event.get('id')) == ident:
                return event

    def until(self, predicate, timeout=60):
        deadline = time.monotonic() + timeout
        while True:
            event = self.inbox.get(timeout=max(0.01,deadline-time.monotonic()))
            if 'process_eof' in event:
                raise RuntimeError('child ended before expected event')
            if predicate(event):
                return event

    def close(self):
        if self.child.poll() is None:
            self.child.stdin.close()
            try:
                self.child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.child.terminate()
                try:
                    self.child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=3)
        for thread in self.threads:
            thread.join(timeout=1)
        return {'command': self.command,'pid':self.child.pid,'exit_code':self.child.returncode,
                'events':self.events,'stderr':''.join(self.stderr),'cleanup':'owned child exited'}
