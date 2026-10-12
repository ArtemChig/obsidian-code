import { defineTool, fail, ok } from './types';

type TaskInput = { description: string; prompt: string; subagent_type?: string };

export const taskTool = defineTool<TaskInput>(
  {
    name: 'Task',
    description:
      'Run a subagent for a self-contained job and get its final report. subagent_type: general-purpose (default), Explore (read-only search), Plan (read-only planning), or a custom type from the system prompt. ' +
      'It cannot see this conversation: write a complete prompt and say what to report back. Several Task calls in one message run in parallel. Not for simple lookups.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '3-5 word summary' },
        prompt: { type: 'string', description: 'Full instructions' },
        subagent_type: { type: 'string' },
      },
      required: ['description', 'prompt'],
    },
    concurrencySafe: true,
    permission: () => 'none',
    title: (i) => `Task: ${i.description ?? ''}`.trim(),
    ruleFor: () => 'Task',

    async run(input, ctx) {
      const agentType = input.subagent_type?.trim() || 'general-purpose';
      if (!input.prompt.trim()) return fail('prompt must not be empty.');
      let r;
      try {
        r = await ctx.runSubagent({ agentType, description: input.description, prompt: input.prompt });
      } catch (e) {
        if (ctx.signal?.aborted) return fail('Interrupted by user.');
        return fail(`Subagent "${agentType}" failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return ok(r.result?.trim() ? r.result : '(The subagent finished without returning any text.)', {
        display: { kind: 'subagent', sessionId: r.sessionId, agentType, description: input.description },
      });
    },
  },
  { aliases: { subagent_type: ['agent_type', 'agent', 'type', 'subagentType'], prompt: ['task', 'instructions'], description: ['summary', 'title'] } },
);
