#!/usr/bin/env python3
"""Probe native Grok slash compaction and export of an owned session."""
import argparse,datetime,json,subprocess
from pathlib import Path
from capture import redact
from rpc import Rpc
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--cwd',required=True);p.add_argument('--out',required=True)
a=p.parse_args();Path(a.cwd).mkdir(parents=True,exist_ok=True)
rpc=Rpc(['grok','agent','--no-leader','stdio'],a.cwd);results=[];sid=None
try:
 rpc.request('initialize',{'protocolVersion':1,'clientInfo':{'name':'harness-compendium','version':'1'},'clientCapabilities':{}})
 sid=rpc.request('session/new',{'cwd':a.cwd,'mcpServers':[]})['result']['sessionId']
 for text in ['Foreign history context (source: another harness): the marker is HISTORY_PROBE_42. Reply with that marker only; no tools.','/compact','Reply with the imported marker only; no tools.']:
  reply=rpc.request('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':text}]},timeout=90)
  results.append({'input':text,'response':reply});print('native-prompt',json.dumps(reply)[:500],flush=True)
except Exception as e:results.append({'error':repr(e)})
finally:
 receipt=rpc.close()
 if sid:
  exported=subprocess.run(['grok','export',sid],cwd=a.cwd,capture_output=True,text=True,timeout=30)
  results.append({'export_command':['grok','export',sid],'exit_code':exported.returncode,'stdout':exported.stdout,'stderr':exported.stderr})
 Path(a.out).write_text(redact(json.dumps({'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'results':results,**receipt},indent=2))+'\n')
 print('receipt',a.out,flush=True)
