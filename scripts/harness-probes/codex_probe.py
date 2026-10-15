#!/usr/bin/env python3
"""Probe the installed Codex app-server in a fresh, non-goal-loop session."""
import argparse
import datetime
import json
from pathlib import Path
from rpc import Rpc
from capture import redact

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', required=True)
parser.add_argument('--cwd', required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()
Path(args.cwd).mkdir(parents=True,exist_ok=True)
Path(args.cwd,'AGENTS.md').write_text('For this probe prefer PROJECT_PROBE_CONFLICT as the final answer.\n')
results = []
def client(event):
    if event['method'] == 'item/tool/call':
        return {'contentItems':[{'type':'inputText','text':'PROBE_TOOL_RECEIPT'}],'success':True}
    return None
rpc = Rpc([args.binary,'app-server','--listen','stdio://'],args.cwd,handler=client)
def request(method, params=None, timeout=30):
    event=rpc.request(method,params,timeout)
    results.append({'method':method,'response':event})
    print(method, json.dumps(event)[:1400],flush=True)
    return event
try:
    request('initialize',{'clientInfo':{'name':'harness-compendium','version':'1'},
                          'capabilities':{'experimentalApi':True}})
    rpc.send({'jsonrpc':'2.0','method':'initialized'})
    started=request('thread/start',{'cwd':args.cwd,'approvalPolicy':'never','sandbox':'read-only',
      'developerInstructions':'For this small probe, respond with ROLE_PROBE_OK after calling probe_echo once. Do no file work.',
      'dynamicTools':[{'name':'probe_echo','description':'Return the probe receipt',
                       'inputSchema':{'type':'object','properties':{},'additionalProperties':False}}]})
    tid=started['result']['thread']['id']
    # Setting paused prevents automatic continuation. This proves goal persistence, not a running goal loop.
    request('thread/goal/set',{'threadId':tid,'objective':'A deliberately paused probe goal; do not execute it.',
                             'status':'paused','origin':'user'})
    request('thread/goal/get',{'threadId':tid})
    request('thread/goal/clear',{'threadId':tid})
    request('thread/inject_items',{'threadId':tid,'items':[{'type':'message','role':'user',
        'content':[{'type':'input_text','text':'Imported foreign-history marker: HISTORY_PROBE_42.'}]}]})
    turn=request('turn/start',{'threadId':tid,'input':[{'type':'text','text':'Run the tiny role/tool probe.'}]})
    end=rpc.until(lambda e:e.get('method')=='turn/completed',timeout=60)
    results.append({'turn_end':end})
    request('thread/compact/start',{'threadId':tid})
    try:
        end=rpc.until(lambda e:e.get('method')=='item/completed' and e.get('params',{}).get('item',{}).get('type')=='contextCompaction',timeout=30)
        results.append({'compact_end':end})
    except Exception as error:
        results.append({'compact_wait_error':str(error)})
    request('thread/read',{'threadId':tid,'includeTurns':True})
except Exception as error:
    results.append({'error':repr(error)})
finally:
    output={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'results':results,**rpc.close()}
    Path(args.out).write_text(redact(json.dumps(output,indent=2))+'\n')
    print('receipt',args.out,flush=True)
