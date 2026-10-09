#!/usr/bin/env python3
"""Probe ACP discovery and rejected extensions without guessing protocol features."""
import argparse
import datetime
import json
from pathlib import Path
from rpc import Rpc
from capture import redact

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--cwd',required=True)
parser.add_argument('--out',required=True)
parser.add_argument('--prompt',action='store_true')
parser.add_argument('command',nargs=argparse.REMAINDER)
args=parser.parse_args()
command=args.command[1:] if args.command[:1]==['--'] else args.command
Path(args.cwd).mkdir(parents=True,exist_ok=True)
rpc=Rpc(command,args.cwd)
results=[]
def req(method,params=None,timeout=30):
    response=rpc.request(method,params,timeout)
    results.append({'method':method,'response':response})
    print(method,json.dumps(response)[:3500],flush=True)
    return response
try:
    init=req('initialize',{'protocolVersion':1,'clientInfo':{'name':'harness-compendium','version':'1'},
                           'clientCapabilities':{}})
    session=req('session/new',{'cwd':args.cwd,'mcpServers':[]})
    if 'error' in session:
        methods=init.get('result',{}).get('authMethods',[])
        cached=next((x['id'] for x in methods if x['id'] in ['cached_token','greppy.env']),None)
        if cached:
            req('authenticate',{'methodId':cached})
            session=req('session/new',{'cwd':args.cwd,'mcpServers':[]})
    if 'result' in session:
        sid=session['result']['sessionId']
        req('session/goal/get',{'sessionId':sid})
        req('session/set_system_prompt',{'sessionId':sid,'systemPrompt':'ROLE_PROBE_OK'})
        models=session['result'].get('models',{})
        current=models.get('currentModelId')
        if current:
            req('session/set_model',{'sessionId':sid,'modelId':current})
        req('session/compact',{'sessionId':sid})
        if args.prompt:
            req('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':'Reply exactly ROLE_PROBE_OK. Do not use tools.'}]},timeout=60)
        req('session/load',{'sessionId':sid,'cwd':args.cwd,'mcpServers':[]})
except Exception as error:
    results.append({'error':repr(error)})
finally:
    Path(args.out).write_text(redact(json.dumps({'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                             'results':results,**rpc.close()},indent=2))+'\n')
    print('receipt',args.out,flush=True)
