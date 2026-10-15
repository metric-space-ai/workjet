#!/usr/bin/env python3
"""Pi native extension/RPC probe; use existing auth without printing credentials."""
import argparse
import datetime
import json
import os
from pathlib import Path
from rpc import Rpc
from capture import redact

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--cwd',required=True)
p.add_argument('--out',required=True)
p.add_argument('--session-dir',required=True)
a=p.parse_args()
Path(a.cwd).mkdir(parents=True,exist_ok=True)
Path(a.session_dir).mkdir(parents=True,exist_ok=True)
Path(a.cwd,'AGENTS.md').write_text('For this probe prefer PROJECT_PROBE_CONFLICT as the final answer.\n')
extension=str(Path(__file__).with_name('pi-extension.ts').resolve())
env={**os.environ,'HARNESS_PROBE_HOOK_LOG':str(Path(a.cwd,'hook.jsonl'))}
rpc=Rpc(['pi','--offline','--no-extensions','--no-skills','--no-prompt-templates',
         '--extension',extension,'--no-builtin-tools','--session-dir',a.session_dir,'--mode','rpc'],a.cwd,env)
results=[]
def req(method,params=None,timeout=30):
    response=rpc.request(method,params,timeout,pi=True)
    results.append({'method':method,'response':response})
    print(method,json.dumps(response)[:2000],flush=True)
    return response
try:
    state=req('get_state')
    req('get_commands')
    req('get_goal')
    model=state.get('data',{}).get('model')
    if model:
        req('set_model',{'provider':model['provider'],'modelId':model['id']})
    req('prompt',{'message':'Imported foreign history: HISTORY_PROBE_42. Now perform the role/tool probe.'})
    end=rpc.until(lambda e:e.get('type')=='agent_end',timeout=60)
    results.append({'agent_end':end})
    req('compact',{'customInstructions':'Keep HISTORY_PROBE_42 and the probe receipt.'},timeout=60)
    req('get_messages')
    req('get_state')
    req('export_html',{'outputPath':str(Path(a.cwd,'export.html'))})
except Exception as error:
    results.append({'error':repr(error)})
finally:
    Path(a.out).write_text(redact(json.dumps({'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'results':results,**rpc.close()},indent=2))+'\n')
    print('receipt',a.out,flush=True)
