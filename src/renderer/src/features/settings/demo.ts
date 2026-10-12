// Demo-mode data for the Settings view (loaded automatically with ?demo=1). Owner: ui-views.
import { registerDemoData } from '@renderer/lib/demo';

registerDemoData((d) => ({
  settings: {
    ...d.settings,
    custom: [
      ...d.settings.custom,
      { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
    ],
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\dev\\notes'] },
      docs: { type: 'http', url: 'https://docs.example.com/mcp', enabled: false },
    },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', command: 'node scripts/check-command.mjs', timeoutMs: 5000 }],
    },
  },
  providers: [{ id: 'custom:lmstudio', label: 'LM Studio', status: 'offline', baseUrl: 'http://127.0.0.1:1234/v1', detail: 'Connection refused' }],
  secrets: { 'custom.openrouter.apiKey': false, 'custom.lmstudio.apiKey': false },
}));
