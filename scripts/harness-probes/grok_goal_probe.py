#!/usr/bin/env python3
"""Exercise advertised Grok /goal commands on a bounded, isolated objective."""
import argparse
import datetime
import json
from pathlib import Path
from rpc import Rpc
from capture import redact

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--cwd',required=True)
p.add_argument('--out',required=True)
a=p.parse_args()
Path(a.cwd).mkdir(parents=True,exist_ok=True)
rpc=Rpc(['grok','agent','--no-leader','stdio'],a.cwd)
results=[]
def req(method,params=None,timeout=30):
 response=rpc.request(method,params,timeout)
 results.append({'method':method,'response':response})
 print(method,json.dumps(response)[:600],flush=True)
 return response
try:
 req('initialize',{'protocolVersion':1,'clientInfo':{'name':'harness-compendium','version':'1'},'clientCapabilities':{}})
 sid=req('session/new',{'cwd':a.cwd,'mcpServers':[]})['result']['sessionId']
 for text in ['/goal status','/goal Reply exactly GOAL_PROBE_COMPLETE, mark the goal complete and stop. No tools or other work.','/goal status','/goal clear']:
  req('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':text}]},timeout=60)
except Exception as error:results.append({'error':repr(error)})
finally:
 Path(a.out).write_text(redact(json.dumps({'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),
  'results':results,**rpc.close()},indent=2))+'\n')
 print('receipt',a.out,flush=True)
