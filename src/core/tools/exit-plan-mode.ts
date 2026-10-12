import { defineTool, fail, ok } from './types';

type ExitPlanInput = { plan: string };

export const exitPlanModeTool = defineTool<ExitPlanInput>(
  {
    name: 'ExitPlanMode',
    description:
      'In plan mode, once your research is done, present the implementation plan (Markdown: concrete steps, files to change) for the user to approve. This is how approval is requested; do not ask in text. Not for research-only tasks.',
    inputSchema: {
      type: 'object',
      properties: { plan: { type: 'string', description: 'Plan in Markdown' } },
      required: ['plan'],
    },
    concurrencySafe: false,
    permission: () => 'none',
    title: () => 'Present plan for approval',
    ruleFor: () => 'ExitPlanMode',

    async run(input, ctx) {
      const plan = input.plan.trim();
      if (!plan) return fail('plan must not be empty.');
      const r = await ctx.requestPlanApproval(plan);
      if (r.approved) {
        const modeNote = r.mode === 'acceptEdits' ? ' File edits are now auto-accepted.' : r.mode === 'bypassPermissions' ? ' Permission prompts are disabled.' : '';
        return ok(`User has approved your plan. You can now start implementing it.${modeNote} Start by updating your todo list with TodoWrite if the plan has several steps.${r.feedback ? `\nUser notes: ${r.feedback}` : ''}`, {
          display: { kind: 'plan', plan },
        });
      }
      return ok(`The user did not approve the plan and wants you to keep planning.${r.feedback ? `\nUser feedback: ${r.feedback}` : ''}\nRevise the plan accordingly and call ExitPlanMode again when ready.`, {
        display: { kind: 'plan', plan },
      });
    },
  },
  { aliases: { plan: ['plan_text', 'proposal', 'summary'] } },
);
