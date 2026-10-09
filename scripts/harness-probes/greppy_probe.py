#!/usr/bin/env python3
"""Use the existing loopback credential and a model returned by its live /models."""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import urllib.request
from rpc import Rpc
from capture import redact

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--cwd',required=True)
p.add_argument('--out',required=True)
p.add_argument('--key-helper',required=True)
p.add_argument('--catalog',required=True)
a=p.parse_args()
key=subprocess.check_output(['python3',a.key_helper],text=True,timeout=5).strip()
endpoint='http://127.0.0.1:8317'
with urllib.request.urlopen(urllib.request.Request(endpoint+'/v1/models',headers={'Authorization':'Bearer '+key}),timeout=10) as response:
    ids=[x['id'] for x in json.load(response)['data']]
live=json.loads(Path(a.catalog).read_text())['catalog']
observed={m for x in live['providers'] if x['status']=='observed' for m in x['models']}
matching=[m for m in ids if m in observed and m.lower().startswith('glm')]
if not matching:raise SystemExit('No live-observed configured model for the bounded probe')
model=matching[0]
Path(a.cwd).mkdir(parents=True,exist_ok=True)
rpc=Rpc(['greppy','agent','stdio','--max-turns','4'],a.cwd,
        env={**os.environ,'GREPPY_ENDPOINT':endpoint,'GREPPY_API_KEY':key,'GREPPY_MODEL':model})
results=[]
def req(method,params=None,timeout=30):
    response=rpc.request(method,params,timeout)
    results.append({'method':method,'response':response})
    print(method,json.dumps(response)[:1200],flush=True)
    return response
try:
    req('initialize',{'protocolVersion':1,'clientInfo':{'name':'harness-compendium','version':'1'},'clientCapabilities':{}})
    session=req('session/new',{'cwd':a.cwd,'mcpServers':[]})['result']
    sid=session['sessionId']
    req('session/set_model',{'sessionId':sid,'modelId':model})
    req('_workjet/import_history',{'sessionId':sid,'messages':[
        {'id':'history-probe-user','role':'user','text':'Remember foreign marker HISTORY_PROBE_42.'},
        {'id':'history-probe-assistant','role':'assistant','text':'Acknowledged HISTORY_PROBE_42.'}]})
    req('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':'Reply with the exact imported marker. Do not use tools.'}]},timeout=60)
    req('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':'/compact'}]},timeout=60)
    req('session/load',{'sessionId':sid,'cwd':a.cwd,'mcpServers':[]})
    req('session/new',{'cwd':a.cwd,'mcpServers':[{'name':'workjet_probe','command':'python3',
        'args':[str(Path(__file__).with_name('mcp_echo.py').resolve())],'env':[]}]})
except Exception as error:results.append({'error':repr(error)})
finally:
    Path(a.out).write_text(redact(json.dumps({'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'results':results,**rpc.close()},indent=2))+'\n')
    print('receipt',a.out,flush=True)
