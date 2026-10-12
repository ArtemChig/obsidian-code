// Text helpers: line splitting, cat -n formatting, truncation, newline conversion.

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '' && /\n$/.test(text)) lines.pop();
  return lines;
}

/** cat -n style: right-aligned 6-wide number, tab, line. */
export function catN(lines: string[], startLine: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) out.push(`${String(startLine + i).padStart(6)}\t${lines[i]}`);
  return out.join('\n');
}

export function truncateLine(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max)}… [line truncated, ${line.length - max} more chars]` : line;
}

/** Keep the head and tail of long text, dropping the middle. headRatio = share of the budget given to the head. */
export function truncateMiddle(text: string, max: number, headRatio = 0.3): string {
  if (max <= 0 || text.length <= max) return text;
  const head = Math.floor(max * headRatio);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n… [${omitted} characters omitted] …\n\n${text.slice(text.length - tail)}`;
}

export function truncateEnd(text: string, max: number, note?: string): string {
  if (max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}\n${note ?? `… [truncated, ${text.length - max} more characters]`}`;
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function toCrlf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

export function detectEol(text: string): 'crlf' | 'lf' {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? 'crlf' : 'lf';
}

export function countOccurrences(hay: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

export function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === '') return out;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function oneLine(s: string, max = 100): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
