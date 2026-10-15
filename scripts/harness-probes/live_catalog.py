#!/usr/bin/env python3
"""Read a real /models endpoint; never print or persist its credential."""
import argparse
import datetime
import json
from pathlib import Path
import os
import subprocess
import urllib.error
import urllib.request
from capture import redact

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--url',required=True)
p.add_argument('--out',required=True)
p.add_argument('--pi-provider')
p.add_argument('--key-env')
p.add_argument('--key-helper')
a=p.parse_args()
key=os.environ.get(a.key_env,'') if a.key_env else ''
if a.key_helper:
    key=subprocess.check_output(['python3',a.key_helper],text=True,timeout=5).strip()
if a.pi_provider:
    auth=json.loads((Path.home()/'.pi/agent/auth.json').read_text())
    entry=auth.get(a.pi_provider,{})
    if entry.get('type')=='api_key':key=entry.get('key','')
request=urllib.request.Request(a.url,headers={'Authorization':'Bearer '+key} if key else {})
result={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'url':a.url,
        'credential_used':bool(key),'method':'GET'}
try:
    with urllib.request.urlopen(request,timeout=15) as response:
        body=json.load(response)
        result.update(status=response.status,ids=[x['id'] for x in body.get('data',[]) if isinstance(x,dict) and isinstance(x.get('id'),str)])
except urllib.error.HTTPError as error:
    result.update(status=error.code,error=redact(error.read(1000).decode(errors='replace')))
except Exception as error:
    result['error']=str(error)
Path(a.out).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='ids'}))
print('live model count',len(result.get('ids',[])))
