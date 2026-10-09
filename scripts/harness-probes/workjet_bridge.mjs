// Probe facade over the real Workjet mailbox RPC and transcript read API.
// Credentials are read from an owned mode-0600 scratch file, never argv/output.
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.env.HARNESS_PROBE_BRIDGE_CONFIG, 'utf8'));
const source = process.env.HARNESS_PROBE_SOURCE_THREAD;
const [operation, target, text] = process.argv.slice(2);
if (![config.threadA, config.threadB].includes(source)) throw new Error('Unbound source');
if (![config.threadA, config.threadB].includes(target)) throw new Error('Out-of-probe target');
const headers = { Cookie: config.cookie, 'Content-Type': 'application/json' };
if (operation === 'read') {
  if (target !== source) throw new Error('Probe permits reading only the bound thread');
  const response = await fetch(config.origin + '/api/orchestration/threads/' + encodeURIComponent(target), { headers });
  if (!response.ok) throw new Error('Snapshot HTTP ' + response.status);
  const body = await response.json();
  console.log(JSON.stringify(body));
} else if (operation === 'send') {
  const response = await fetch(config.origin + '/api/auth/websocket-ticket', { method: 'POST', headers });
  if (!response.ok) throw new Error('Ticket HTTP ' + response.status);
  const { ticket } = await response.json();
  const url = new URL('/ws', config.origin.replace('http:', 'ws:'));
  url.searchParams.set('wsTicket', ticket);
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const deadline = setTimeout(() => { socket.close(); reject(new Error('Mailbox response timeout')); }, 15000);
    socket.onopen = () => socket.send(JSON.stringify({ _tag: 'Request', id: 'probe-1', tag: 'workjet.mailbox.sendMessage',
      payload: { sourceThreadId: source, targetThreadId: target, targetEnvironmentId: config.environmentId,
        body: { _tag: 'inline', text } }, headers: [] }) + '\n');
    socket.onmessage = (event) => {
      for (const line of String(event.data).trim().split('\n')) {
        const message = JSON.parse(line);
        if (message._tag === 'Ping') { socket.send(JSON.stringify({ _tag: 'Pong' }) + '\n'); continue; }
        if (message._tag === 'Exit' && String(message.requestId) === 'probe-1') {
          clearTimeout(deadline); socket.close();
          if (message.exit._tag === 'Success') { console.log(JSON.stringify(message.exit.value)); resolve(); }
          else reject(new Error(JSON.stringify(message.exit)));
        }
      }
    };
    socket.onerror = () => { clearTimeout(deadline); reject(new Error('Mailbox socket error')); };
    socket.onclose = () => clearTimeout(deadline);
  });
} else throw new Error('Use send or read');
