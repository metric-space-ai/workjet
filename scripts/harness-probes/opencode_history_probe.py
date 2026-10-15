#!/usr/bin/env python3
"""OpenCode foreign-context conversion, same-session model config and JSON roundtrip."""
import argparse,datetime,json,os,subprocess,urllib.request
from pathlib import Path
from capture import redact
from rpc import Rpc
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--cwd',required=True);p.add_argument('--out',required=True);p.add_argument('--key-helper',required=True);p.add_argument('--catalog',required=True)
a=p.parse_args();base=Path(a.cwd);base.mkdir(parents=True,exist_ok=True)
key=subprocess.check_output(['python3',a.key_helper],text=True,timeout=5).strip()
with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8317/v1/models',headers={'Authorization':'Bearer '+key}),timeout=10) as r:listed=[m['id'] for m in json.load(r)['data']]
verified={m for row in json.loads(Path(a.catalog).read_text())['catalog']['providers'] if row['status']=='observed' for m in row['models']}
models=[m for m in listed if m in verified and m.lower().startswith('glm')]
if len(models)<2:raise RuntimeError('Two verified live-listed models are required')
config={'provider':{'probe':{'npm':'@ai-sdk/openai-compatible','options':{'baseURL':'http://127.0.0.1:8317/v1','apiKey':key},'models':{m:{'name':m} for m in models}}},'model':'probe/'+models[0]}
env={**os.environ,'OPENCODE_CONFIG_CONTENT':json.dumps(config)}
rpc=Rpc(['opencode','--pure','acp'],str(base),env);results=[];sid=None
try:
 rpc.request('initialize',{'protocolVersion':1,'clientInfo':{'name':'harness-compendium','version':'1'},'clientCapabilities':{}})
 started=rpc.request('session/new',{'cwd':str(base),'mcpServers':[]});results.append({'session_new':started});sid=started['result']['sessionId']
 def prompt(text):
  response=rpc.request('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':text}]},timeout=90)
  results.append({'input':text,'response':response});print('prompt',json.dumps(response)[:400],flush=True)
 prompt('Imported foreign user/assistant context: the other harness recorded HISTORY_PROBE_42. Reply with that marker only; no tools.')
 changed=rpc.request('session/set_config_option',{'sessionId':sid,'configId':'model','value':'probe/'+models[1]});results.append({'model_change':changed})
 prompt('/compact Keep HISTORY_PROBE_42.')
 prompt('After model switch and compaction, reply with the exact imported marker only; no tools.')
 results.append({'session_load':rpc.request('session/load',{'sessionId':sid,'cwd':str(base),'mcpServers':[]})})
except Exception as e:results.append({'error':repr(e)})
finally:
 receipt=rpc.close()
 if sid:
  exported=subprocess.run(['opencode','--pure','export',sid],cwd=str(base),env=env,capture_output=True,text=True,timeout=30)
  results.append({'export_exit_code':exported.returncode,'export_stderr':exported.stderr})
  if exported.returncode==0:
   data=json.loads(exported.stdout);file=base/'export.json';file.write_text(json.dumps(data))
   # Roundtrip only this owned session. No transcript from a user's native session is mutated.
   imported=subprocess.run(['opencode','--pure','import',str(file)],cwd=str(base),env=env,capture_output=True,text=True,timeout=30)
   results.append({'export_keys':list(data),'export_message_count':len(data.get('messages',[])),
      'import_exit_code':imported.returncode,'import_stdout':imported.stdout,'import_stderr':imported.stderr})
 Path(a.out).write_text(redact(json.dumps({'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'results':results,**receipt},indent=2))+'\n')
 print('receipt',a.out,flush=True)
