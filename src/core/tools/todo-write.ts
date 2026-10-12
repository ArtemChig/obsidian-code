import type { Todo } from '../../shared/types';
import { defineTool, fail, ok } from './types';

type TodoInput = { todos: { id?: string; content: string; status: Todo['status']; activeForm?: string }[] };

const STATUS_SYNONYMS: Record<string, Todo['status']> = {
  done: 'completed', complete: 'completed', finished: 'completed', 'in progress': 'in_progress', inprogress: 'in_progress',
  doing: 'in_progress', active: 'in_progress', todo: 'pending', 'to do': 'pending', open: 'pending', not_started: 'pending',
};

export const todoWriteTool = defineTool<TodoInput>(
  {
    name: 'TodoWrite',
    description:
      'Track the task list for work with 3+ steps. Send the COMPLETE list each time (it replaces the old one). Keep exactly one item in_progress and mark items completed as soon as they are done. ' +
      'Skip for trivial requests.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Imperative task, e.g. "Run tests"' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: { type: 'string', description: 'e.g. "Running tests"' },
              id: { type: 'string' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    concurrencySafe: false,
    permission: () => 'none',
    title: (i) => `Update todos${Array.isArray(i.todos) ? ` (${i.todos.length})` : ''}`,
    ruleFor: () => 'TodoWrite',

    async run(input, ctx) {
      const seen = new Set<string>();
      const todos: Todo[] = [];
      for (let i = 0; i < input.todos.length; i++) {
        const t = input.todos[i];
        const content = String(t.content ?? '').trim();
        if (!content) return fail(`Todo ${i + 1} has empty content.`);
        let id = t.id ? String(t.id) : String(i + 1);
        if (seen.has(id)) id = `${id}-${i + 1}`;
        seen.add(id);
        const todo: Todo = { id, content, status: t.status };
        if (t.activeForm && String(t.activeForm).trim()) todo.activeForm = String(t.activeForm).trim();
        todos.push(todo);
      }
      ctx.todos.set(todos);
      const count = (s: Todo['status']) => todos.filter((t) => t.status === s).length;
      const inProgress = count('in_progress');
      let msg = `Todo list updated (${todos.length} item${todos.length === 1 ? '' : 's'}: ${count('completed')} completed, ${inProgress} in progress, ${count('pending')} pending).`;
      if (inProgress > 1) msg += ' Note: keep only one task in_progress at a time.';
      if (todos.length > 0 && count('completed') === todos.length) msg += ' All tasks are complete.';
      else msg += ' Continue with the current task.';
      return ok(msg, { display: { kind: 'todos', todos } });
    },
  },
  {
    aliases: { todos: ['items', 'tasks', 'todo_list', 'list'] },
    prepare(input) {
      const todos = input.todos;
      if (!Array.isArray(todos)) return input;
      return {
        ...input,
        todos: todos.map((t) => {
          if (typeof t === 'string') return { content: t, status: 'pending' };
          if (typeof t !== 'object' || t === null) return t;
          const o = { ...(t as Record<string, unknown>) };
          if (o.content === undefined) o.content = o.task ?? o.title ?? o.description ?? o.text;
          if (typeof o.status === 'string') o.status = STATUS_SYNONYMS[o.status.toLowerCase().trim()] ?? o.status;
          if (o.status === undefined) o.status = 'pending';
          if (typeof o.id === 'number') o.id = String(o.id);
          return o;
        }),
      };
    },
  },
);
