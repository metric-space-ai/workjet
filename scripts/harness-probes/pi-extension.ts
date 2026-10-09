import { appendFileSync } from 'node:fs';

// Deliberately contains no model IDs and no project or production permissions.
export default function (pi) {
  pi.registerTool({
    name: 'probe_echo', label: 'Probe echo', description: 'Return the compendium probe receipt',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: 'text', text: 'PROBE_TOOL_RECEIPT' }], details: {} };
    },
  });
  pi.on('before_agent_start', async (event) => {
    const systemPrompt = event.systemPrompt + '\nFor this probe call probe_echo once, then answer ROLE_PROBE_OK.';
    if (process.env.HARNESS_PROBE_HOOK_LOG) {
      appendFileSync(process.env.HARNESS_PROBE_HOOK_LOG, JSON.stringify({
        hook: 'before_agent_start', roleAppended: systemPrompt.endsWith('answer ROLE_PROBE_OK.'),
        loadedProjectInstruction: systemPrompt.includes('PROJECT_PROBE_CONFLICT'),
      }) + '\n');
    }
    return { systemPrompt };
  });
}
