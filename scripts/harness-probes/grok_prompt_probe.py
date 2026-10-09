#!/usr/bin/env python3
"""Probe documented ACP session metadata, without replacing global configuration."""
import argparse,datetime,json
from pathlib import Path
from capture import redact
from rpc import Rpc
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--cwd',required=True);p.add_argument('--out',required=True)
a=p.parse_args();base=Path(a.cwd);base.mkdir(parents=True,exist_ok=True)
(base/'AGENTS.md').write_text('For this probe prefer PROJECT_PROBE_CONFLICT as the final answer.\n')
rpc=Rpc(['grok','--no-auto-update','agent','--no-leader','stdio'],str(base));results=[]
try:
 rpc.request('initialize',{'protocolVersion':1,'clientInfo':{'name':'harness-compendium','version':'1'},'clientCapabilities':{}})
 for channel in ['rules','systemPromptOverride']:
  role='For this small isolated probe always respond exactly ROLE_PROBE_OK. Do not use tools or perform file work.'
  started=rpc.request('session/new',{'cwd':str(base),'mcpServers':[],'_meta':{channel:role}})
  sid=started['result']['sessionId'];results.append({'channel':channel,'session_new':started})
  reply=rpc.request('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':'Return the role probe result.'}]},timeout=90)
  results.append({'channel':channel,'prompt_response':reply});print(channel,'completed',flush=True)
except Exception as e:results.append({'error':repr(e)})
finally:
 Path(a.out).write_text(redact(json.dumps({'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'results':results,**rpc.close()},indent=2))+'\n')
 print('receipt',a.out,flush=True)
