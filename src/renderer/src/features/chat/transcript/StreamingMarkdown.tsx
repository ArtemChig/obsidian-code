// Streaming-friendly markdown: split into top-level blocks, each memoised on its own text, so while a reply streams
// only the last block re-renders (no flicker, no re-highlighting of finished code blocks). Owner: ui-chat.
import { memo, useMemo } from 'react';
import { Markdown } from '@renderer/components/ui/markdown';
import { cn } from '@renderer/lib/cn';
import { splitMarkdownBlocks } from '../lib/markdown-blocks';

const Block = memo(function Block({ text, first }: { text: string; first: boolean }) {
  const heading = /^#{1,6}\s/.test(text);
  return (
    <div className={cn('[&:not(:last-child)]:mb-[0.8em]', heading && !first && 'pt-2.5')}>
      <Markdown text={text} />
    </div>
  );
});

export const StreamingMarkdown = memo(function StreamingMarkdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  return (
    <div className={cn('min-w-0', className)} data-testid="assistant-text">
      {blocks.map((b, i) => (
        <Block key={i} text={b} first={i === 0} />
      ))}
    </div>
  );
});
