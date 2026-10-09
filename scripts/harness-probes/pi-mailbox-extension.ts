import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Probe-only facade. The parent binds identity privately; the model cannot set it.
export default function (pi) {
  const bridge = fileURLToPath(new URL('./mailbox_tools_cli.py', import.meta.url));
  for (const tool of [
    { name: 'thread_send', description: 'Send a durable message to the other Workjet probe thread.',
      parameters: { type: 'object', properties: { targetThreadId: { type: 'string' }, text: { type: 'string', maxLength: 4096 } }, required: ['targetThreadId', 'text'], additionalProperties: false } },
    { name: 'thread_read', description: 'Read incoming messages of your bound Workjet probe thread.',
      parameters: { type: 'object', properties: {}, additionalProperties: false } },
  ]) {
    pi.registerTool({ ...tool, label: tool.name, async execute(_id, args) {
      const text = execFileSync('python3', [bridge, tool.name, JSON.stringify(args)], { encoding: 'utf8', timeout: 25000 });
      return { content: [{ type: 'text', text }], details: {} };
    } });
  }
  pi.on('before_agent_start', async (event) => ({ systemPrompt: event.systemPrompt + '\nUse only the two mailbox tools for this isolated exchange. Do no file work.' }));
}
