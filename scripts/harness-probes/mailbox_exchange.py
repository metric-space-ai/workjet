"""Native Pi extension ↔ OpenCode ACP/MCP exchange over Workjet mailbox."""
import json
import os
from pathlib import Path
from rpc import Rpc


def exchange(config_path,base,model,key):
    config=json.loads(Path(config_path).read_text())
    scripts=Path(__file__).resolve().parent
    results=[]
    def permission(event):
        if event.get('method')=='session/request_permission':
            if not any(name in json.dumps(event['params']) for name in ['thread_send','thread_read']):
                return {'outcome':{'outcome':'cancelled'}}
            choice=next((x for x in event['params']['options'] if x['kind']=='allow_once'),None)
            return {'outcome':{'outcome':'selected','optionId':choice['optionId']}} if choice else {'outcome':{'outcome':'cancelled'}}
        return None
    def pi_turn(message):
        reply=pi.request('prompt',{'message':message},pi=True)
        end=pi.until(lambda e:e.get('type')=='agent_end' and not e.get('willRetry'),timeout=90)
        results.append({'harness':'pi','prompt_ack':reply,'agent_end':end})
    agent=base/'pi-agent';agent.mkdir(exist_ok=True)
    (agent/'settings.json').write_text(json.dumps({'defaultProvider':'zai','defaultModel':config['piModel']}))
    env={**os.environ,'HARNESS_PROBE_BRIDGE_CONFIG':str(config_path),'HARNESS_PROBE_SOURCE_THREAD':config['threadA'],
         'PI_CODING_AGENT_DIR':str(agent)}
    pi=Rpc(['pi','--offline','--no-extensions','--no-skills','--no-prompt-templates',
            '--extension',str(scripts/'pi-mailbox-extension.ts'),'--no-builtin-tools',
            '--provider','zai','--model',config['piModel'],'--session-dir',str(base/'pi-sessions'),'--mode','rpc'],str(base),env)
    opencode=None
    try:
        results.append({'harness':'pi','workjet_thread_id':config['threadA'],'state':pi.request('get_state',pi=True)})
        pi_turn('Send MAILBOX_NATIVE_A to Workjet thread '+config['threadB']+' using thread_send. Then reply SENT_A.')
        role='Use only the injected mailbox tools for this isolated exchange. Do no file work.'
        native_config={'provider':{'probe':{'npm':'@ai-sdk/openai-compatible',
             'options':{'baseURL':'http://127.0.0.1:8317/v1','apiKey':key},'models':{model:{'name':model}}}},
             'model':'probe/'+model,'agent':{'compendium':{'mode':'primary','prompt':role}}}
        opencode=Rpc(['opencode','--pure','acp'],str(base),{**os.environ,'OPENCODE_CONFIG_CONTENT':json.dumps(native_config)},permission)
        opencode.request('initialize',{'protocolVersion':1,'clientInfo':{'name':'harness-compendium','version':'1'},'clientCapabilities':{}})
        sid=opencode.request('session/new',{'cwd':str(base),'mcpServers':[{'name':'workjet_probe','command':'python3',
            'args':[str(scripts/'mcp_mailbox.py')],'env':[{'name':'HARNESS_PROBE_BRIDGE_CONFIG','value':str(config_path)},
            {'name':'HARNESS_PROBE_SOURCE_THREAD','value':config['threadB']}]}]})['result']['sessionId']
        opencode.request('session/set_mode',{'sessionId':sid,'modeId':'compendium'})
        reply=opencode.request('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':
            'Call thread_read. If the incoming body says MAILBOX_NATIVE_A, send MAILBOX_NATIVE_B in reply to Workjet thread '+config['threadA']+' using thread_send. Then reply RECEIVED_A_SENT_B.'}]},timeout=90)
        results.append({'harness':'opencode','workjet_thread_id':config['threadB'],'session_id':sid,'prompt_response':reply})
        pi_turn('Call thread_read now. Reply RECEIVED_B only if the incoming body says MAILBOX_NATIVE_B.')
    except Exception as error:
        results.append({'error':repr(error)})
    finally:
        if opencode:results.append({'native_receipt':opencode.close()})
        results.append({'native_receipt':pi.close()})
    return results
