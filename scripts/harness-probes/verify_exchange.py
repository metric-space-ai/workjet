#!/usr/bin/env python3
"""Verify actual native tool receipts form a two-way Workjet mailbox exchange."""
import argparse,json
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--receipt',required=True);p.add_argument('--out',required=True)
a=p.parse_args();raw=json.loads(Path(a.receipt).read_text())
pi={};oc={}
for row in raw['results']:
 r=row.get('native_receipt')
 if not r:continue
 if r['command'][0]=='pi':
  for entry in r['events']:
   e=entry.get('receive',{})
   if e.get('type')=='tool_execution_end' and not e.get('isError'):
    pi[e['toolName']]=json.loads(e['result']['content'][0]['text'])
 else:
  names={}
  for entry in r['events']:
   u=entry.get('receive',{}).get('params',{}).get('update',{})
   if u.get('sessionUpdate')=='tool_call':names[u['toolCallId']]=u['title']
   if u.get('sessionUpdate')=='tool_call_update' and u.get('status')=='completed':
    name=names.get(u['toolCallId'],'')
    text=u.get('rawOutput',{}).get('output')
    if text:oc[name]=json.loads(text)
pa=pi['thread_send'];pr=pi['thread_read'];or_=oc['workjet_probe_thread_read'];ob=oc['workjet_probe_thread_send']
received_a=next(m for m in or_['messages'] if m['envelopeId']==pa['envelopeId'])
received_b=next(m for m in pr['messages'] if m['envelopeId']==ob['envelopeId'])
checks={'pi_send_acknowledged':pa['status']=='acknowledged','opencode_read_same_envelope':received_a['body']['text']=='MAILBOX_NATIVE_A',
        'opencode_send_acknowledged':ob['status']=='acknowledged','pi_read_same_reply_envelope':received_b['body']['text']=='MAILBOX_NATIVE_B',
        'opposite_threads':received_a['source']['threadId']==received_b['target']['threadId'] and received_a['target']['threadId']==received_b['source']['threadId']}
summary={'source_receipt':Path(a.receipt).name,'measured_at':raw['time'],'server_version':'0.0.70',
         'harnesses':['Pi 0.80.2','OpenCode 1.18.35'],'threadA':received_a['source']['threadId'],'threadB':received_a['target']['threadId'],
         'envelopeA':pa['envelopeId'],'envelopeB':ob['envelopeId'],'checks':checks,'pass':all(checks.values()),
         'limits':'Local installed-server RPC send; prototype read-only inbox facade; externally bound native sessions, not installed adapter/UI acceptance.'}
Path(a.out).write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
if not summary['pass']:raise SystemExit(1)
