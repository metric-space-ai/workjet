#!/usr/bin/env python3
"""Convert readable foreign history to Pi JSONL; compact and switch live models."""
import argparse
import datetime
import json
import os
from pathlib import Path
import urllib.request
import uuid
from capture import redact
from rpc import Rpc

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--cwd',required=True);p.add_argument('--out',required=True)
a=p.parse_args();base=Path(a.cwd);base.mkdir(parents=True,exist_ok=True)
(base/'.pi').mkdir(exist_ok=True)
(base/'.pi/settings.json').write_text(json.dumps({'compaction':{'keepRecentTokens':128,'reserveTokens':1024}}))
now=datetime.datetime.now(datetime.timezone.utc).isoformat()
session=base/'imported.jsonl';entries=[{'type':'session','version':3,'id':str(uuid.uuid4()),'timestamp':now,'cwd':str(base)}]
parent=None
for i in range(5):
 ident=uuid.uuid4().hex[:8]
 # Foreign tool/assistant records are readable user context, not forged signatures.
 text='Imported foreign record '+str(i)+': HISTORY_PROBE_42 is the durable marker. '+('Bounded probe context; no file work or external effects. '*120)
 entries.append({'type':'message','id':ident,'parentId':parent,'timestamp':now,'message':{'role':'user','content':text,'timestamp':int(datetime.datetime.now().timestamp()*1000)}})
 parent=ident
session.write_text('\n'.join(json.dumps(x) for x in entries)+'\n')
key=os.environ['ZAI_API_KEY']
with urllib.request.urlopen(urllib.request.Request('https://api.z.ai/api/coding/paas/v4/models',headers={'Authorization':'Bearer '+key}),timeout=15) as response:
 live={x['id'] for x in json.load(response)['data']}
agent=base/'agent';agent.mkdir(exist_ok=True)
defaults=json.loads((Path.home()/'.pi/agent/settings.json').read_text())
if defaults['defaultProvider']!='zai' or defaults['defaultModel'] not in live:raise RuntimeError('Pi default is not live-listed')
(agent/'settings.json').write_text(json.dumps({'defaultProvider':'zai','defaultModel':defaults['defaultModel']}))
rpc=Rpc(['pi','--approve','--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-builtin-tools','--session',str(session),'--mode','rpc'],str(base),
        env={**os.environ,'PI_CODING_AGENT_DIR':str(agent)})
results=[]
def req(method,params=None,timeout=30):
 response=rpc.request(method,params,timeout,pi=True);results.append({'method':method,'response':response})
 print(method,json.dumps(response)[:1500],flush=True);return response
try:
 state=req('get_state');current=state['data']['model']
 if current['provider']!='zai' or current['id'] not in live:raise RuntimeError('Configured model is not in the authenticated Z.ai list')
 results.append({'imported_entry_count':len(entries)-1,'source':'readable foreign user-context records','live_model_check':True})
 req('compact',{'customInstructions':'Preserve the marker HISTORY_PROBE_42.'},timeout=90)
 models=req('get_available_models')['data']['models']
 target=next(m for m in models if m['provider']=='zai' and m['id'] in live and m['id']!=current['id'])
 req('set_model',{'provider':'zai','modelId':target['id']})
 req('prompt',{'message':'Reply with the exact imported marker only.'})
 results.append({'agent_end':rpc.until(lambda e:e.get('type')=='agent_end' and not e.get('willRetry'),timeout=90)})
 req('get_state')
 req('get_messages')
 req('export_html',{'outputPath':str(base/'export.html')})
except Exception as error:results.append({'error':repr(error)})
finally:
 Path(a.out).write_text(redact(json.dumps({'time':now,'results':results,**rpc.close()},indent=2))+'\n')
 print('receipt',a.out,flush=True)
