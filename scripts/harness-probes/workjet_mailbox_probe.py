#!/usr/bin/env python3
"""Start a disposable installed server; create two real threads through its API."""
import argparse
import datetime
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from capture import redact
from mailbox_exchange import exchange

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--server',required=True);p.add_argument('--base-dir',required=True);p.add_argument('--out',required=True)
p.add_argument('--catalog',required=True);p.add_argument('--key-helper',required=True)
a=p.parse_args()
base=Path(a.base_dir)/str(uuid.uuid4());base.mkdir(parents=True,exist_ok=True)
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
secret=secrets.token_urlsafe(32)
logs=[];results=[]
bootstrap=base/'bootstrap-private.json'
bootstrap.write_text(json.dumps({'mode':'desktop','noBrowser':True,'port':port,'host':'127.0.0.1',
    'workjetHome':str(base),'desktopBootstrapToken':secret,'tailscaleServeEnabled':False,'tailscaleServePort':443})+'\n')
bootstrap.chmod(0o600)
bootfd=os.open(bootstrap,os.O_RDONLY)
server=subprocess.Popen(['node',a.server,'--bootstrap-fd',str(bootfd)],cwd=str(Path(__file__).resolve().parents[2]),
    pass_fds=(bootfd,),stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,start_new_session=True)
os.close(bootfd)
print('owned_server_pid',server.pid,flush=True)
def drain():
 for line in server.stdout:
  logs.append(redact(line))
reader=threading.Thread(target=drain,daemon=True);reader.start()

origin='http://127.0.0.1:'+str(port)
def http(path,body=None,cookie=None):
 headers={'Content-Type':'application/json'}
 if cookie:headers['Cookie']=cookie
 request=urllib.request.Request(origin+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
 with urllib.request.urlopen(request,timeout=15) as response:
  return json.load(response),response.headers
try:
 # Bounded readiness wait for an isolated process, not a business-flow assertion.
 deadline=time.monotonic()+30
 while True:
  try:http('/api/auth/session');break
  except (OSError,urllib.error.URLError):
   if server.poll() is not None or time.monotonic()>deadline:raise RuntimeError('Disposable server did not become ready')
   time.sleep(0.25)
 auth,headers=http('/api/auth/browser-session',{'credential':secret})
 cookie=headers['Set-Cookie'].split(';',1)[0]
 results.append({'auth':{k:v for k,v in auth.items() if k not in ['token','sessionToken']}})
 key=subprocess.check_output(['python3',a.key_helper],text=True,timeout=5).strip()
 with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8317/v1/models',headers={'Authorization':'Bearer '+key}),timeout=10) as r:
  models=[x['id'] for x in json.load(r)['data']]
 observed={m for x in json.loads(Path(a.catalog).read_text())['catalog']['providers'] if x['status']=='observed' for m in x['models']}
 model=next(m for m in models if m in observed and m.lower().startswith('glm'))
 with urllib.request.urlopen(urllib.request.Request('https://api.z.ai/api/coding/paas/v4/models',
      headers={'Authorization':'Bearer '+os.environ['ZAI_API_KEY']}),timeout=15) as r:
  zai_models={x['id'] for x in json.load(r)['data']}
 pi_settings=json.loads((Path.home()/'.pi/agent/settings.json').read_text())
 pi_model=pi_settings['defaultModel']
 if pi_settings['defaultProvider']!='zai' or pi_model not in zai_models:raise RuntimeError('Configured Pi model not in live account list')
 project='harness-probe-'+str(uuid.uuid4());threadA=str(uuid.uuid4());threadB=str(uuid.uuid4())
 now=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
 def dispatch(command):
  response,_=http('/api/orchestration/dispatch',{'commandId':str(uuid.uuid4()),**command},cookie)
  results.append({'command':command['type'],'response':response});return response
 dispatch({'type':'project.create','projectId':project,'title':'Isolated harness probe','workspaceRoot':str(base),'createdAt':now})
 # Pi and OpenCode execute externally through probe facades, not installed adapters.
 # The two persisted Workjet records retain stable identity throughout the exchange.
 for tid,driver in [(threadA,'pi'),(threadB,'opencode')]:
  dispatch({'type':'thread.create','threadId':tid,'projectId':project,'title':'Probe '+driver,
   'modelSelection':{'instanceId':driver,'model':pi_model if driver=='pi' else model},'runtimeMode':'approval-required',
   'workjetConfig':{'schemaVersion':1,'role':'orchestrator','parent':None,'managedInstructions':'Isolated mailbox probe','enabledCapabilityIds':[]},
   'branch':None,'worktreePath':None,'createdAt':now})
 snapshot,_=http('/api/orchestration/snapshot',cookie=cookie)
 environmentId=(base/'userdata/environment-id').read_text().strip()
 config={'origin':origin,'cookie':cookie,'threadA':threadA,'threadB':threadB,'environmentId':environmentId,
    'database':str(base/'userdata/state.sqlite'),'piModel':pi_model}
 path=base/'bridge-private.json';path.write_text(json.dumps(config));path.chmod(0o600)
 results.append({'threads_created':[threadA,threadB],'environmentId':environmentId,'snapshot_thread_count':len(snapshot.get('threads',[]))})
 bridge=str(Path(__file__).with_name('workjet_bridge.mjs').resolve())
 for source,target,text in [(threadA,threadB,'MAILBOX_PROBE_A'),(threadB,threadA,'MAILBOX_PROBE_B')]:
  completed=subprocess.run(['node',bridge,'send',target,text],env={**os.environ,'HARNESS_PROBE_BRIDGE_CONFIG':str(path),
       'HARNESS_PROBE_SOURCE_THREAD':source},capture_output=True,text=True,timeout=25)
  results.append({'bridge_source':source,'bridge_target':target,'exit_code':completed.returncode,
     'stdout':redact(completed.stdout),'stderr':redact(completed.stderr)})
 results.extend(exchange(path,base,model,key))
except Exception as error:results.append({'error':repr(error)})
finally:

 if server.poll() is None:
  server.terminate()
  try:server.wait(timeout=5)
  except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
 reader.join(timeout=1)
 Path(a.out).write_text(json.dumps({'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'pid':server.pid,
  'server_exit_code':server.returncode,'results':results,'server_log':logs[-30:],'cleanup':'owned disposable server exited'},indent=2)+'\n')
 print('receipt',a.out,'results',len(results),flush=True)
