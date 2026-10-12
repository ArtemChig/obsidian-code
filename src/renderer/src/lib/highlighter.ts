// Lazy shiki highlighter with the custom "obsidian-dark" theme and on-demand languages. Owner: ui-foundation.
// JS regex engine (no WASM). Languages are code-split and loaded the first time they are used.
import type { HighlighterCore, LanguageInput, ThemedToken } from 'shiki/core';
import { obsidianShikiTheme } from '../design/shiki-theme';

type LangLoader = () => Promise<{ default: LanguageInput }>;

const LANGS: Record<string, LangLoader> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  bat: () => import('shiki/langs/bat.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  cmake: () => import('shiki/langs/cmake.mjs'),
  zig: () => import('shiki/langs/zig.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  regexp: () => import('shiki/langs/regexp.mjs'),
  nginx: () => import('shiki/langs/nginx.mjs'),
  hcl: () => import('shiki/langs/hcl.mjs'),
};

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  sh: 'shellscript',
  bash: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
  console: 'shellscript',
  shellsession: 'shellscript',
  ps1: 'powershell',
  psm1: 'powershell',
  pwsh: 'powershell',
  ps: 'powershell',
  cmd: 'bat',
  batch: 'bat',
  py: 'python',
  python3: 'python',
  rs: 'rust',
  golang: 'go',
  htm: 'html',
  svg: 'xml',
  xhtml: 'xml',
  md: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  jsonl: 'json',
  json5: 'jsonc',
  patch: 'diff',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  h: 'c',
  cs: 'csharp',
  'c#': 'csharp',
  kt: 'kotlin',
  kts: 'kotlin',
  rb: 'ruby',
  docker: 'dockerfile',
  makefile: 'make',
  mk: 'make',
  tf: 'hcl',
  conf: 'ini',
  cfg: 'ini',
  env: 'ini',
  gql: 'graphql',
  text: 'plaintext',
  txt: 'plaintext',
  plain: 'plaintext',
};

/** Normalised shiki language id, 'plaintext', or null when unknown. */
export function resolveLang(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const l = lang.trim().toLowerCase();
  if (l === 'plaintext') return 'plaintext';
  if (LANGS[l]) return l;
  const a = ALIASES[l];
  return a ?? null;
}

/** Guess a language from a file path ("src/app.tsx" → "tsx", "Dockerfile" → "dockerfile"). */
export function langFromPath(path: string): string | undefined {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'make';
  if (name === 'cmakelists.txt') return 'cmake';
  if (name.startsWith('.env')) return 'ini';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return resolveLang(ext) ?? undefined;
}

/** Display label for a language id ("typescript" → "TypeScript"). */
export function langLabel(lang: string | null | undefined): string {
  if (!lang) return 'text';
  const r = resolveLang(lang) ?? lang;
  const labels: Record<string, string> = {
    typescript: 'TypeScript',
    tsx: 'TSX',
    javascript: 'JavaScript',
    jsx: 'JSX',
    json: 'JSON',
    jsonc: 'JSONC',
    shellscript: 'Shell',
    powershell: 'PowerShell',
    bat: 'Batch',
    python: 'Python',
    csharp: 'C#',
    cpp: 'C++',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    yaml: 'YAML',
    toml: 'TOML',
    sql: 'SQL',
    xml: 'XML',
    markdown: 'Markdown',
    plaintext: 'text',
  };
  return labels[r] ?? r;
}

let hlPromise: Promise<HighlighterCore> | null = null;
let hl: HighlighterCore | null = null;
const loaded = new Set<string>();
const loading = new Map<string, Promise<boolean>>();

function getHighlighter(): Promise<HighlighterCore> {
  if (!hlPromise) {
    hlPromise = Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(async ([core, eng]) => {
      const h = await core.createHighlighterCore({
        themes: [obsidianShikiTheme],
        langs: [],
        engine: eng.createJavaScriptRegexEngine({ forgiving: true }),
      });
      hl = h;
      return h;
    });
  }
  return hlPromise;
}

/** Ensure a language is loaded; resolves false for unknown/plaintext languages. */
export function ensureLanguage(lang: string): Promise<boolean> {
  const id = resolveLang(lang);
  if (!id || id === 'plaintext') return Promise.resolve(false);
  if (loaded.has(id)) return Promise.resolve(true);
  let p = loading.get(id);
  if (!p) {
    p = getHighlighter()
      .then(async (h) => {
        const mod = await LANGS[id]();
        await h.loadLanguage(mod.default);
        loaded.add(id);
        return true;
      })
      .catch((err) => {
        console.warn(`[highlighter] could not load ${id}`, err);
        return false;
      });
    loading.set(id, p);
  }
  return p;
}

export const MAX_HIGHLIGHT_CHARS = 80_000;

/** Synchronous tokenisation — returns null until the highlighter + language are loaded (call ensureLanguage first). */
export function tokenizeSync(code: string, lang: string): ThemedToken[][] | null {
  const id = resolveLang(lang);
  if (!hl || !id || !loaded.has(id) || code.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    return hl.codeToTokensBase(code, { lang: id, theme: 'obsidian-dark' });
  } catch {
    return null;
  }
}

export type { ThemedToken };
