#!/usr/bin/env python3
"""Stdio MCP binding of the isolated mailbox prototype tools."""
import json
import sys
from mailbox_tools import TOOLS,call
for line in sys.stdin:
    event=json.loads(line)
    if 'id' not in event:continue
    method=event.get('method')
    try:
        if method=='initialize':result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'workjet_probe','version':'1'}}
        elif method=='tools/list':result={'tools':TOOLS}
        elif method=='tools/call':
            value=call(event['params']['name'],event['params'].get('arguments',{}))
            result={'content':[{'type':'text','text':json.dumps(value)}]}
        elif method=='ping':result={}
        else:raise ValueError('Unsupported probe method')
        print(json.dumps({'jsonrpc':'2.0','id':event['id'],'result':result}),flush=True)
    except Exception as error:
        print(json.dumps({'jsonrpc':'2.0','id':event['id'],'error':{'code':-32603,'message':str(error)}}),flush=True)
