// Measure the first-turn prompt size (system prompt + tool schemas) against the local llama-server.
// Usage: npx tsx scripts/measure-prompt.ts [baseUrl]
import { builtinTools } from '../src/core/tools/index';
import { buildSystemPrompt, localDate, osName } from '../src/core/agent/prompt';
import { BUILTIN_AGENTS } from '../src/core/agent/subagents';

const base = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'http://127.0.0.1:8080';

async function tok(content: string): Promise<number> {
  const r = await fetch(`${base}/tokenize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
  const j = (await r.json()) as { tokens: unknown[] };
  return j.tokens.length;
}
async function template(body: unknown): Promise<string> {
  const r = await fetch(`${base}/apply-template`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json()) as { prompt: string };
  return j.prompt;
}

async function main(): Promise<void> {
  const tools = builtinTools();
  const system = buildSystemPrompt({
    cwd: 'C:/Users/user/project', date: localDate(), os: osName(), shell: 'Git Bash', git: null, memory: '', skills: [],
    agentTypes: BUILTIN_AGENTS.map((b) => ({ name: b.name, description: b.description, tools: b.tools, source: 'builtin' as const })),
    toolNames: tools.map((t) => t.name),
  });
  const specs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const messages = [{ role: 'system', content: system }, { role: 'user', content: 'hi' }];
  const full = await template({ messages, tools: specs, chat_template_kwargs: { enable_thinking: false } });
  const noTools = await template({ messages, chat_template_kwargs: { enable_thinking: false } });
  const total = await tok(full);
  const sys = await tok(noTools);
  console.log(`system prompt: ${system.length} chars, ~${sys} tokens (with template)`);
  console.log(`total first-turn prompt: ${total} tokens (tools: ${total - sys})`);
  const rows: [string, number][] = [];
  for (const s of specs) rows.push([s.function.name, await tok(JSON.stringify(s))]);
  rows.sort((a, b) => b[1] - a[1]);
  for (const [n, t] of rows) console.log(`  ${n.padEnd(22)} ${t}`);
  if (process.argv.includes('--dump')) console.log(full);
}
main().catch((e) => { console.error(e); process.exit(1); });
