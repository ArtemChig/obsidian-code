// Session export: transcript → Markdown (client-side, from the loaded transcript). Owner: ui-chat (unit-tested).
import type { Block, Message, SessionSummary, ToolUseBlock } from '@shared/types';

function textOf(blocks: Block[]): string {
  return blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim();
}

function toolTarget(t: ToolUseBlock): string {
  const i = t.input ?? {};
  const v = i.command ?? i.file_path ?? i.notebook_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.skill ?? '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

function toolLine(t: ToolUseBlock): string {
  const target = toolTarget(t);
  const code = target.includes('`') ? target : `\`${target}\``;
  return `- **${t.name}**${target ? ` ${code}` : ''} — ${t.status}`;
}

/** Markdown for a whole session: header, then one section per message (thinking and hook context left out). */
export function transcriptMarkdown(session: SessionSummary, messages: Message[], exportedAt = Date.now()): string {
  const out: string[] = [`# ${session.title || 'Untitled session'}`, ''];
  out.push(`- Folder: \`${session.cwd}\``);
  if (session.model) out.push(`- Model: \`${session.model.provider}:${session.model.model}\``);
  out.push(`- Exported: ${new Date(exportedAt).toISOString()}`, '', '---', '');
  for (const m of messages) {
    if (m.tag === 'hook') continue;
    if (m.tag === 'compact_summary') {
      out.push('## Summary of the earlier conversation', '', textOf(m.blocks), '');
      continue;
    }
    if (m.role === 'user') {
      out.push(m.tag === 'command' ? '## Command' : '## You', '');
      const text = textOf(m.blocks);
      if (text) out.push(text);
      for (const b of m.blocks) if (b.type === 'image') out.push(`*[image: ${b.name ?? b.mediaType}]*`);
      out.push('');
      continue;
    }
    if (m.role === 'assistant') {
      out.push('## Obsidian Code', '');
      for (const b of m.blocks) {
        if (b.type === 'text' && b.text.trim()) out.push(b.text.trim(), '');
        else if (b.type === 'tool_use') out.push(toolLine(b));
        else if (b.type === 'image') out.push(`*[image: ${b.name ?? b.mediaType}]*`, '');
      }
      if (m.meta?.interrupted) out.push('', '*(interrupted)*');
      out.push('');
      continue;
    }
    const text = textOf(m.blocks);
    if (text) out.push(`> ${text.replace(/\n/g, '\n> ')}`, '');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** A file name for the export: the title, made safe for Windows. */
export function exportFileName(title: string): string {
  const base = (title || 'session').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'session';
  return `${base}.md`;
}
