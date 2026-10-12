import type { Question } from '../../shared/types';
import { defineTool, ok } from './types';

type AskInput = { questions: Question[] };

export const askUserQuestionTool = defineTool<AskInput>(
  {
    name: 'AskUserQuestion',
    description:
      'Ask the user 1-4 multiple-choice questions (2-4 options each) when you need a decision or missing information. The user can always type another answer, so do not add an "Other" option. ' +
      'Not for plan approval (use ExitPlanMode) or things you can look up yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string', description: 'Short label (max 12 chars)' },
              multiSelect: { type: 'boolean' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '1-5 words' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    concurrencySafe: false,
    permission: () => 'none',
    title: (i) => `Ask: ${Array.isArray(i.questions) && i.questions[0] ? String((i.questions[0] as Question).question ?? '').slice(0, 80) : 'question'}`,
    ruleFor: () => 'AskUserQuestion',

    async run(input, ctx) {
      const questions: Question[] = input.questions.map((q, i) => ({
        question: String(q.question).trim(),
        header: String(q.header ?? '').trim().slice(0, 12).trim() || `Q${i + 1}`,
        multiSelect: q.multiSelect === true,
        options: q.options.map((o) => ({ label: String(o.label).trim(), description: String(o.description ?? '').trim() })),
      }));
      const answers = await ctx.askUser(questions);
      const parts = questions.map((q) => {
        const a = answers[q.question] ?? answers[q.header] ?? Object.values(answers)[questions.indexOf(q)] ?? '(no answer)';
        return `"${q.question}"="${a}"`;
      });
      return ok(`User has answered your questions: ${parts.join(', ')}. You can now continue with the user's answers in mind.`, {
        display: { kind: 'questions', questions, answers },
      });
    },
  },
  {
    aliases: { questions: ['question_list', 'items'] },
    prepare(input) {
      let qs = input.questions;
      if (!Array.isArray(qs)) return input;
      qs = qs.map((q) => {
        if (typeof q !== 'object' || q === null) return q;
        const o = { ...(q as Record<string, unknown>) };
        if (o.multiSelect === undefined && o.multi_select !== undefined) o.multiSelect = o.multi_select;
        if (Array.isArray(o.options)) {
          o.options = o.options.map((opt) => (typeof opt === 'string' ? { label: opt, description: '' } : opt));
        }
        return o;
      });
      return { ...input, questions: qs };
    },
  },
);
