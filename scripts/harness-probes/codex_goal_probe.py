#!/usr/bin/env python3
"""Native active-goal smoke probe; clear its goal before shutting down."""
import argparse
import datetime
import json
from pathlib import Path
from rpc import Rpc
from capture import redact
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--binary',required=True);p.add_argument('--cwd',required=True);p.add_argument('--out',required=True)
a=p.parse_args();Path(a.cwd).mkdir(parents=True,exist_ok=True)
rpc=Rpc([a.binary,'app-server','--listen','stdio://'],a.cwd)
results=[];tid=None
def req(method,params=None,timeout=30):
 r=rpc.request(method,params,timeout);results.append({'method':method,'response':r});return r
try:
 req('initialize',{'clientInfo':{'name':'harness-compendium','version':'1'},'capabilities':{'experimentalApi':True}})
 rpc.send({'jsonrpc':'2.0','method':'initialized'})
 tid=req('thread/start',{'cwd':a.cwd,'approvalPolicy':'never','sandbox':'read-only','developerInstructions':
     'This is a small harness goal smoke probe. Do no file work. Once asked to reach a goal, respond with GOAL_PROBE_COMPLETE and use the native goal tool to mark it complete.'})['result']['thread']['id']
 req('thread/goal/set',{'threadId':tid,'objective':'Respond with GOAL_PROBE_COMPLETE and mark this goal complete. No file work.','status':'active','origin':'user'})
 req('turn/start',{'threadId':tid,'input':[{'type':'text','text':'Perform the small goal probe now.'}]})
 results.append({'turn_end':rpc.until(lambda e:e.get('method')=='turn/completed',timeout=60)})
 req('thread/goal/get',{'threadId':tid})
except Exception as e:results.append({'error':repr(e)})
finally:
 if tid:
  try:
   req('thread/goal/clear',{'threadId':tid})
   req('thread/archive',{'threadId':tid})
  except Exception as e:results.append({'cleanup_error':repr(e)})
 Path(a.out).write_text(redact(json.dumps({'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'results':results,**rpc.close()},indent=2))+'\n')
 print(json.dumps({'results':results})[:2400])
