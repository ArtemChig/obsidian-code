// ui-chat: one message as Markdown (the transcript's right-click → "Copy as Markdown").
import { describe, expect, it } from 'vitest';
import type { Message } from '@shared/types';
import { messageMarkdown } from '@renderer/features/chat/lib/export';

const msg = (role: Message['role'], blocks: Message['blocks'], extra: Partial<Message> = {}): Message => ({ id: 'm', role, createdAt: 0, blocks, ...extra });

describe('messageMarkdown', () => {
  it('a user message is its text (images as notes)', () => {
    expect(messageMarkdown(msg('user', [{ type: 'text', text: '  Fix the parser  ' }]))).toBe('Fix the parser\n');
    expect(messageMarkdown(msg('user', [{ type: 'text', text: 'Look' }, { type: 'image', mediaType: 'image/png', data: '', name: 'shot.png' }]))).toBe('Look\n\n*[image: shot.png]*\n');
  });

  it('an assistant message keeps its text and shows the tool calls as bullets', () => {
    const md = messageMarkdown(
      msg('assistant', [
        { type: 'thinking', text: 'private reasoning' },
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'src/a.ts' }, status: 'done' },
        { type: 'text', text: 'Done.' },
      ]),
    );
    expect(md).toBe('Reading the file.\n\n- **Read** `src/a.ts` — done\nDone.\n');
    expect(md).not.toContain('private reasoning');
  });

  it('marks an interrupted reply and is blank for an empty message', () => {
    expect(messageMarkdown(msg('assistant', [{ type: 'text', text: 'Partial' }], { meta: { interrupted: true } }))).toBe('Partial\n\n*(interrupted)*\n');
    expect(messageMarkdown(msg('assistant', [])).trim()).toBe('');
  });
});
