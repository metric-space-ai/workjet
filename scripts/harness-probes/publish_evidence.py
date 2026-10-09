#!/usr/bin/env python3
"""Remove unvalidated catalog IDs, secrets and unrelated commands before committing.

Receipts are deliberately sanitized. The probe scripts rediscover native selections
at runtime; a sanitized response is never a request template or an entitlement list.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
from capture import redact

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('directory')
a=p.parse_args()
root=Path(a.directory)
catalog=json.loads((root/'live-catalog.json').read_text()).get('catalog',{})
verified={m for row in catalog.get('providers',[]) if row.get('status')=='observed' for m in row.get('models',[])}
candidates=set()
def inspect(value,key=''):
 if isinstance(value,dict):
  if isinstance(value.get('id'),str) and ('api' in value or 'provider' in value):candidates.add(value['id'])
  if 'modelUsage' in value and isinstance(value['modelUsage'],dict):candidates.update(value['modelUsage'])
  for k,v in value.items():
   if k in ['modelId','currentModelId','responseModel'] and isinstance(v,str):candidates.add(v)
   if k=='model' and isinstance(v,str) and not v.isdecimal() and v not in ['model','unset']:candidates.add(v)
   inspect(v,k)
 elif isinstance(value,list):
  for v in value:inspect(v,key)

receipts={path:json.loads(path.read_text()) for path in root.glob('*.json')}
for value in receipts.values():inspect(value)
invalid={m for m in candidates if m and m not in verified and not m.startswith('<')}
replacements={m:'<unvalidated-model:'+hashlib.sha256(m.encode()).hexdigest()[:8]+'>' for m in invalid}
relevant={'goal','loop','compact','export','model','resume','context'}
def sanitize(value,key=''):
 if isinstance(value,dict):
  if value.get('type') in ['thinking','reasoning']:return {'type':value['type'],'content':'<omitted reasoning>'}
  if key=='modelUsage':return {'model_entries_omitted':len(value)}
  if key=='catalog':return value  # the observed live-list source is intentionally retained
  return {k:sanitize(v,k) for k,v in value.items() if k not in ['thinking','thinkingSignature','signature']}
 if isinstance(value,list):
  if key=='events':
   kept=[]
   assembled={}
   for entry in value:
    event=entry.get('receive',{})
    method=event.get('method','')
    update=event.get('params',{}).get('update',{})
    if method.startswith('codex/event/') or event.get('type') in ['message_update','message_start','tool_execution_update'] or 'Delta' in method or method.endswith('/delta'):
     continue
    if method=='session/update' and update.get('sessionUpdate') in ['agent_message_chunk','user_message_chunk']:
     params=event.get('params',{})
     group=(params.get('sessionId',''),params.get('_meta',{}).get('promptId',''),bool(params.get('_meta',{}).get('isReplay')),update['sessionUpdate'])
     assembled.setdefault(group,[]).append(update.get('content',{}).get('text',''))
     continue
    if method=='session/update' and update.get('sessionUpdate')=='agent_thought_chunk':continue
    kept.append(sanitize(entry))
   for group,chunks in assembled.items():
    kept.append({'assembled_session_text':{'sessionId':group[0],'promptId':group[1],
       'isReplay':group[2],'kind':group[3],'text':sanitize(''.join(chunks))}})
   return kept
  if key in ['availableModels','options'] and any(isinstance(v,dict) and ('modelId' in v or v.get('value') in candidates) for v in value):
   return [{'catalog_omitted':True,'advertised_count':len(value)}]
  if key in ['availableCommands','commands']:
   value=[v for v in value if isinstance(v,dict) and v.get('name') in relevant]
  return [sanitize(v,key) for v in value]
 if isinstance(value,str):
  value=redact(value)
  for model in sorted(replacements,key=len,reverse=True):
   value=re.sub(r'(?<![A-Za-z0-9_-])'+re.escape(model)+r'(?![A-Za-z0-9_-])',lambda _:replacements[model],value)
  # CLI help examples are supplied by upstream, not verified live models.
  if key=='stdout':
   value='\n'.join(line for line in value.splitlines() if not any(x in line for x in ['model="','--model openai/','--models claude-','--model sonnet:']))+'\n'
  return value
 return value
for path,value in receipts.items():
 if path.name in ['live-catalog.json']:continue
 if path.name.endswith('models.json') and 'ids' in value:
  value['model_count']=len(value['ids'])
  value['ids']=[m for m in value['ids'] if m in verified]
 value=sanitize(value)
 value['publication_note']='Secret redaction; unvalidated model IDs/catalogs and unrelated commands omitted. Runtime scripts rediscover selections.'
 path.write_text(json.dumps(value,indent=2)+'\n')
print('sanitized',len(receipts),'receipts; live-observed IDs',len(verified))
