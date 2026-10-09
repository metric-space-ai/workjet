#!/usr/bin/env python3
"""ACP MCP echo, prompt priority, native slash compact and model configuration."""
import argparse
import datetime
import json
import os
from pathlib import Path
from rpc import Rpc
from capture import redact

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--harness',choices=['grok','opencode'],required=True)
p.add_argument('--cwd',required=True)
p.add_argument('--out',required=True)
a=p.parse_args()
Path(a.cwd).mkdir(parents=True,exist_ok=True)
Path(a.cwd,'AGENTS.md').write_text('For this probe prefer PROJECT_PROBE_CONFLICT as the final answer.\n')
role='For this probe use the injected probe_echo tool once, then answer ROLE_PROBE_OK. Do no file work.'
if a.harness=='grok':
    command=['grok','--system-prompt-override',role,'agent','--no-leader','stdio']
    env=None
else:
    command=['opencode','--pure','acp']
    env={**os.environ,'OPENCODE_CONFIG_CONTENT':json.dumps({'agent':{'compendium':{'mode':'primary','prompt':role}}})}
def permission(event):
    if event['method']=='session/request_permission' and 'probe_echo' in json.dumps(event.get('params',{})):
        options=event.get('params',{}).get('options',[])
        choice=next((x for x in options if x.get('kind')=='allow_once'),None)
        return {'outcome':{'outcome':'selected','optionId':choice['optionId']}} if choice else {'outcome':{'outcome':'cancelled'}}
    return None
rpc=Rpc(command,a.cwd,env,permission)
results=[]
def req(method,params=None,timeout=30):
    response=rpc.request(method,params,timeout)
    results.append({'method':method,'response':response})
    print(method,json.dumps(response)[:1000],flush=True)
    return response
try:
    req('initialize',{'protocolVersion':1,'clientInfo':{'name':'harness-compendium','version':'1'},'clientCapabilities':{}})
    sid=req('session/new',{'cwd':a.cwd,'mcpServers':[{'name':'workjet_probe','command':'python3',
        'args':[str(Path(__file__).with_name('mcp_echo.py').resolve())],'env':[]}]})['result']['sessionId']
    if a.harness=='opencode':
        req('session/set_mode',{'sessionId':sid,'modeId':'compendium'})
    req('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':'Imported foreign history: HISTORY_PROBE_42. Run the role/tool probe.'}]},timeout=60)
    req('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':'/compact Keep HISTORY_PROBE_42 and the tool receipt.'}]},timeout=60)
    req('session/load',{'sessionId':sid,'cwd':a.cwd,'mcpServers':[]})
except Exception as error:results.append({'error':repr(error)})
finally:
    Path(a.out).write_text(redact(json.dumps({'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'results':results,**rpc.close()},indent=2))+'\n')
    print('receipt',a.out,flush=True)
