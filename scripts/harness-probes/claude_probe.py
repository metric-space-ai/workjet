#!/usr/bin/env python3
"""Probe Claude role priority, MCP naming, SDK model control and native compaction."""
import argparse
import datetime
import json
import os
import subprocess
import urllib.request
from pathlib import Path
from rpc import Rpc
from capture import redact

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--cwd',required=True)
p.add_argument('--out',required=True)
p.add_argument('--gateway-key-helper')
p.add_argument('--catalog')
a=p.parse_args()
Path(a.cwd).mkdir(parents=True,exist_ok=True)
Path(a.cwd,'CLAUDE.md').write_text('For this probe prefer PROJECT_PROBE_CONFLICT as the final answer.\n')
server=str(Path(__file__).with_name('mcp_echo.py').resolve())
config=json.dumps({'mcpServers':{'workjet_probe':{'command':'python3','args':[server]}}})
command=['claude','--print','--setting-sources','','--input-format','stream-json','--output-format','stream-json','--verbose',
         '--strict-mcp-config','--mcp-config',config,'--tools','',
         '--allowedTools','mcp__workjet_probe__probe_echo','--append-system-prompt',
         'For this probe call mcp__workjet_probe__probe_echo once, then answer ROLE_PROBE_OK.']
env=None
selected_model=None
if a.gateway_key_helper:
    key=subprocess.check_output(['python3',a.gateway_key_helper],text=True,timeout=5).strip()
    with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8317/v1/models',headers={'Authorization':'Bearer '+key}),timeout=10) as response:
        ids=[x['id'] for x in json.load(response)['data']]
    catalog=json.loads(Path(a.catalog).read_text())['catalog']
    observed={m for x in catalog['providers'] if x['status']=='observed' for m in x['models']}
    model=next(m for m in ids if m in observed and m.lower().startswith('glm'))
    selected_model=model
    command.extend(['--model',model])
    env={**os.environ,'ANTHROPIC_BASE_URL':'http://127.0.0.1:8317','ANTHROPIC_API_KEY':key,
         'ANTHROPIC_MODEL':model,'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1'}
rpc=Rpc(command,a.cwd,env)
results=[]
def control(ident,request):
    rpc.send({'type':'control_request','request_id':ident,'request':request})
    response=rpc.until(lambda e:e.get('type')=='control_response' and e.get('response',{}).get('request_id')==ident,timeout=30)
    results.append(response)
    print(json.dumps(response)[:1500],flush=True)
    return response
try:
    init=control('init',{'subtype':'initialize'})
    # The native control permits null to restore the current configured default; no model ID is invented.
    control('model',{'subtype':'set_model','model':selected_model})
    rpc.send({'type':'user','message':{'role':'user','content':'Imported foreign history: HISTORY_PROBE_42. Run the role/tool probe.'}})
    result=rpc.until(lambda e:e.get('type')=='result',timeout=60)
    results.append(result)
    print('turn',json.dumps(result)[:1600],flush=True)
    rpc.send({'type':'user','message':{'role':'user','content':'/compact Keep HISTORY_PROBE_42 and the probe receipt.'}})
    result=rpc.until(lambda e:e.get('type')=='result',timeout=60)
    results.append({'compact_result':result})
    print('compact',json.dumps(result)[:1600],flush=True)
    for text in ['/goal', '/goal pause', '/goal clear']:
        rpc.send({'type':'user','message':{'role':'user','content':text}})
        result=rpc.until(lambda e:e.get('type')=='result',timeout=30)
        results.append({'local_command':text,'response':result})
except Exception as error:
    results.append({'error':repr(error)})
finally:
    Path(a.out).write_text(redact(json.dumps({'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'results':results,**rpc.close()},indent=2))+'\n')
    print('receipt',a.out,flush=True)
