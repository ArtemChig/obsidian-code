// Split streaming markdown into top-level blocks so finished blocks keep their identity (and their rendered DOM)
// while only the last one re-renders on every delta. Owner: ui-chat. Pure (unit-tested).

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])\s/;
const TABLE_ROW = /^ {0,3}\|/;

/**
 * Returns blocks whose concatenation (joined with "\n\n") renders the same as the input in practice:
 * paragraphs, headings, fenced code (blank lines inside fences never split), lists and tables kept whole.
 */
export function splitMarkdownBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[][] = [];
  let cur: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (cur.length) blocks.push(cur);
    cur = [];
  };

  for (const line of lines) {
    if (fence) {
      cur.push(line);
      const m = FENCE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      // A fence starts a new block unless it is indented under a list item (code inside a list).
      if (cur.length && !/^\s{2,}/.test(line)) flush();
      fence = open[1];
      cur.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    cur.push(line);
  }
  flush();

  // Merge blocks that markdown treats as one container: list items separated by blank lines (loose lists),
  // indented continuations of a list item, and adjacent tables.
  const merged: string[][] = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const first = b[0];
      const prevFirst = prev[0];
      const prevIsList = LIST_ITEM.test(prevFirst);
      const continuesList = prevIsList && (LIST_ITEM.test(first) || /^\s{2,}\S/.test(first));
      const continuesTable = TABLE_ROW.test(prevFirst) && TABLE_ROW.test(first);
      if (continuesList || continuesTable) {
        prev.push('', ...b);
        continue;
      }
    }
    merged.push(b.slice());
  }
  return merged.map((b) => b.join('\n'));
}
