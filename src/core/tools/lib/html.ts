// HTML → Markdown for WebFetch: Readability (main content) via linkedom, then Turndown.

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MarkdownResult { title: string; markdown: string }

let turndown: TurndownService | undefined;

function getTurndown(): TurndownService {
  if (turndown) return turndown;
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    hr: '---',
  });
  td.remove(['script', 'style', 'noscript', 'template', 'iframe', 'canvas', 'svg', 'button', 'form', 'select']);
  // Compact list items ("- item" rather than Turndown's default "-   item") to save tokens.
  td.addRule('listItem', {
    filter: 'li',
    replacement: (content: string, node: any, options: any) => {
      const body = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n  ');
      let prefix = `${options.bulletListMarker} `;
      const parent = node.parentNode;
      if (parent && parent.nodeName === 'OL') {
        const start = parent.getAttribute('start');
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start ? Number(start) + index : index + 1}. `;
      }
      return prefix + body + (node.nextSibling && !/\n$/.test(body) ? '\n' : '');
    },
  });
  td.addRule('img', {
    filter: 'img',
    replacement: (_content: string, node: any) => {
      const alt = String(node.getAttribute?.('alt') ?? '').trim();
      return alt ? `[image: ${alt}]` : '';
    },
  });
  turndown = td;
  return td;
}

function absolutize(html: string, base: string): string {
  const { document } = parseHTML(`<!doctype html><html><body><div id="oc-root">${html}</div></body></html>`) as any;
  const fix = (sel: string, attr: string) => {
    for (const el of document.querySelectorAll(sel)) {
      const v = el.getAttribute(attr);
      if (!v || v.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(v)) continue;
      try {
        el.setAttribute(attr, new URL(v, base).href);
      } catch { /* leave as is */ }
    }
  };
  fix('a[href]', 'href');
  fix('img[src]', 'src');
  return document.getElementById('oc-root')?.innerHTML ?? html;
}

function tidy(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    // token savers: citation markers like [[3]](#cite_note-3), empty links, in-page anchors, link titles
    .replace(/\[\\\[[\w\s,.-]{1,12}\\\]\]\(#[^)]*\)/g, '')
    .replace(/\[\]\([^)]*\)/g, '')
    .replace(/\[([^\]\n]+)\]\(#[^)]*\)/g, '$1')
    .replace(/\]\(([^\s)]+) "[^"\n]*"\)/g, ']($1)')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function bodyFallback(html: string): string {
  const { document } = parseHTML(html) as any;
  for (const el of document.querySelectorAll('script, style, noscript, template, nav, footer, header, aside, iframe, svg, form')) el.remove();
  return (document.body ?? document.documentElement)?.innerHTML ?? '';
}

export function htmlToMarkdown(html: string, url: string): MarkdownResult {
  const { document } = parseHTML(html) as any;
  const title: string =
    String(document.title ?? '').trim() ||
    String(document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '').trim();
  const bodyText = String(document.body?.textContent ?? '').replace(/\s+/g, ' ').trim();

  let content = '';
  let articleLen = 0;
  try {
    const article = new Readability(document as any, { charThreshold: 100 }).parse();
    if (article?.content) {
      content = article.content;
      articleLen = String(article.textContent ?? '').replace(/\s+/g, ' ').trim().length;
    }
  } catch { /* fall back to the whole body */ }

  if (!content || (articleLen < 500 && bodyText.length > articleLen * 3)) {
    content = bodyFallback(html);
  }
  const md = tidy(getTurndown().turndown(absolutize(content, url)));
  return { title, markdown: md };
}
