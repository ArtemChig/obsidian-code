// Markdown renderer for chat prose: react-markdown + remark-gfm, NO raw HTML, code via CodeBlock,
// links open externally. Owner: ui-foundation.
import { Children, isValidElement, memo, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openExternal } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { CodeBlock } from './code-block';

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

const SAFE_IMG = /^(data:image\/|blob:)/i;

const components: Components = {
  a: ({ href, children, title }) => (
    <a
      href={href}
      title={title ?? href}
      onClick={(e) => {
        e.preventDefault();
        if (href) openExternal(href);
      }}
      onAuxClick={(e) => e.preventDefault()}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
    </a>
  ),
  pre: ({ children }) => {
    const child = Children.toArray(children)[0];
    if (isValidElement(child)) {
      const props = (child as ReactElement<{ className?: string; children?: ReactNode }>).props;
      const lang = /language-([\w#+.-]+)/.exec(props.className ?? '')?.[1];
      const code = textOf(props.children).replace(/\n$/, '');
      return <CodeBlock code={code} lang={lang} />;
    }
    return <pre className="ob-code">{children}</pre>;
  },
  table: ({ children }) => (
    <div className="ob-table-wrap">
      <table>{children}</table>
    </div>
  ),
  img: ({ src, alt }) => {
    const s = typeof src === 'string' ? src : '';
    if (SAFE_IMG.test(s)) return <img src={s} alt={alt ?? ''} loading="lazy" />;
    // Remote images are not loaded (privacy + CSP): show a link instead.
    return s ? (
      <a
        href={s}
        onClick={(e) => {
          e.preventDefault();
          openExternal(s);
        }}
      >
        {alt || s}
      </a>
    ) : null;
  },
  input: ({ checked, type }) => (type === 'checkbox' ? <input type="checkbox" checked={!!checked} readOnly disabled /> : null),
};

export interface MarkdownProps {
  /** Markdown source. */
  text: string;
  className?: string;
  /** Smaller 13 px variant for tool cards and panels. */
  compact?: boolean;
}

/** Renders untrusted markdown safely (raw HTML is dropped). Memoised on text. */
export const Markdown = memo(function Markdown({ text, className, compact }: MarkdownProps) {
  return (
    <div className={cn('ob-prose ob-selectable', compact && 'ob-prose-compact', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
