#!/usr/bin/env python3
"""Probe-only stdio MCP server; never accesses Workjet state or user files."""
import json
import sys

for line in sys.stdin:
    event=json.loads(line)
    if 'id' not in event:
        continue
    method=event.get('method')
    if method=='initialize':
        result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},
                'serverInfo':{'name':'workjet_probe','version':'1'}}
    elif method=='tools/list':
        result={'tools':[{'name':'probe_echo','description':'Return the compendium probe receipt',
                         'inputSchema':{'type':'object','properties':{},'additionalProperties':False}}]}
    elif method=='tools/call' and event.get('params',{}).get('name')=='probe_echo':
        result={'content':[{'type':'text','text':'PROBE_TOOL_RECEIPT'}]}
    elif method=='ping':
        result={}
    else:
        print(json.dumps({'jsonrpc':'2.0','id':event['id'],'error':{'code':-32601,'message':'Unsupported probe method'}}),flush=True)
        continue
    print(json.dumps({'jsonrpc':'2.0','id':event['id'],'result':result}),flush=True)
