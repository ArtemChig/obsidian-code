// CodeBlock: shiki-highlighted code with language label + copy button. Owner: ui-foundation.
import { Check, Copy, TextWrap } from 'lucide-react';
import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';
import { ensureLanguage, langLabel, resolveLang, tokenizeSync, type ThemedToken } from '@renderer/lib/highlighter';
import { IconButton } from './button';

export interface CodeBlockProps {
  code: string;
  /** Language id or alias ("ts", "bash", "py"…). Unknown → plain text. */
  lang?: string | null;
  /** Shown in the header instead of the language (e.g. a file path). */
  title?: ReactNode;
  showLineNumbers?: boolean;
  /** First line number when showLineNumbers (file excerpts). */
  startLine?: number;
  /** Soft-wrap long lines (toggleable from the header). */
  wrap?: boolean;
  /** Max height in px before scrolling (default: none). */
  maxHeight?: number;
  /** Hide the header bar entirely (copy button then floats on hover). */
  bare?: boolean;
  /** Extra header actions (right side, before copy). */
  actions?: ReactNode;
  /** Per-line extra class (1-based line number, e.g. diff add/del rows). */
  lineClassName?: (lineNumber: number, text: string) => string | undefined;
  className?: string;
}

function useTokens(code: string, lang: string | null | undefined): ThemedToken[][] | null {
  const id = resolveLang(lang);
  const [ready, setReady] = useState(() => (id ? tokenizeSync('', id) !== null : false));
  useEffect(() => {
    let alive = true;
    if (!id || id === 'plaintext') return;
    void ensureLanguage(id).then((ok) => {
      if (alive && ok) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [id]);
  return useMemo(() => (ready && id ? tokenizeSync(code, id) : null), [ready, id, code]);
}

const FONT_STYLE: Record<number, CSSProperties> = {
  1: { fontStyle: 'italic' },
  2: { fontWeight: 600 },
  4: { textDecoration: 'underline' },
};

function tokenStyle(t: ThemedToken): CSSProperties | undefined {
  if (!t.color && !t.fontStyle) return undefined;
  const fs = t.fontStyle && t.fontStyle > 0 ? (FONT_STYLE[t.fontStyle] ?? (t.fontStyle & 1 ? FONT_STYLE[1] : undefined)) : undefined;
  return { color: t.color, ...fs };
}

export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  title,
  showLineNumbers,
  startLine = 1,
  wrap: wrapProp = false,
  maxHeight,
  bare,
  actions,
  lineClassName,
  className,
}: CodeBlockProps) {
  const tokens = useTokens(code, lang);
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(wrapProp);
  useEffect(() => setWrap(wrapProp), [wrapProp]);

  const lines = useMemo(() => code.replace(/\n$/, '').split('\n'), [code]);
  const gutter = String(startLine + lines.length - 1).length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied */
    }
  };

  const copyButton = (
    <IconButton
      label={copied ? 'Copied' : 'Copy code'}
      icon={copied ? <Check size={14} className="text-ob-success" /> : Copy}
      size="sm"
      onClick={copy}
    />
  );

  return (
    <div className={cn('ob-codeblock group/code', className)}>
      {!bare ? (
        <div className="flex h-8 items-center justify-between gap-2 border-b border-ob-border bg-[#101b21] pl-3 pr-1.5">
          <div className="min-w-0 truncate font-mono text-[11px] text-ob-text-3">{title ?? langLabel(lang)}</div>
          <div className="flex shrink-0 items-center gap-0.5">
            {actions}
            <IconButton label={wrap ? 'Disable line wrap' : 'Wrap lines'} icon={TextWrap} size="sm" active={wrap} onClick={() => setWrap((w) => !w)} />
            {copyButton}
          </div>
        </div>
      ) : (
        <div className="absolute right-1.5 top-1.5 z-10 opacity-0 transition-opacity group-hover/code:opacity-100">{copyButton}</div>
      )}
      <pre
        className={cn('ob-code', wrap && 'ob-code-wrap', showLineNumbers && 'ob-code-numbered')}
        style={{ maxHeight, ['--ob-gutter' as string]: `${gutter}ch` }}
      >
        <code>
          {lines.map((text, i) => {
            const n = startLine + i;
            const extra = lineClassName?.(n, text);
            const toks = tokens?.[i];
            return (
              <span key={i} className={cn('ob-line', extra)}>
                {showLineNumbers ? <span className="ob-ln">{n}</span> : null}
                <span>
                  {toks
                    ? toks.map((t, j) => (
                        <span key={j} style={tokenStyle(t)}>
                          {t.content}
                        </span>
                      ))
                    : text || ' '}
                  {toks && toks.length === 0 ? ' ' : null}
                </span>
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
});
