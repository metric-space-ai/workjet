"""Probe facade. Sends through production RPC; inbox read is a scoped prototype.

Only the disposable database supplied by the probe supervisor can be read.
This is not an installed thread.read API or production authorisation implementation.
"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess


def call(name, arguments):
    config=json.loads(Path(os.environ['HARNESS_PROBE_BRIDGE_CONFIG']).read_text())
    source=os.environ['HARNESS_PROBE_SOURCE_THREAD']
    if source not in [config['threadA'],config['threadB']]:raise ValueError('Unbound probe source')
    if name=='thread_send':
        target=arguments['targetThreadId']
        if target not in [config['threadA'],config['threadB']] or target==source:raise ValueError('Out-of-probe target')
        completed=subprocess.run(['node',str(Path(__file__).with_name('workjet_bridge.mjs')),
            'send',target,arguments['text']],env=os.environ,capture_output=True,text=True,timeout=20,check=True)
        return json.loads(completed.stdout)
    if name=='thread_read':
        db=sqlite3.connect('file:'+config['database']+'?mode=ro',uri=True)
        try:
            rows=db.execute('SELECT payload_json FROM workjet_mailbox_inbox ORDER BY received_at_ms LIMIT 100').fetchall()
        finally:db.close()
        messages=[]
        for (raw,) in rows:
            payload=json.loads(raw)
            message=payload.get('message',payload)
            if message.get('target',{}).get('threadId')==source:
                messages.append(message)
        return {'boundThreadId':source,'messages':messages,'readImplementation':'probe-only read-only inbox facade'}
    raise ValueError('Unsupported probe tool')

TOOLS=[{'name':'thread_send','description':'Send a durable message to the other bound Workjet probe thread.',
        'inputSchema':{'type':'object','properties':{'targetThreadId':{'type':'string'},'text':{'type':'string','maxLength':4096}},
                       'required':['targetThreadId','text'],'additionalProperties':False}},
       {'name':'thread_read','description':'Read incoming messages of your bound Workjet probe thread.',
        'inputSchema':{'type':'object','properties':{},'additionalProperties':False}}]
