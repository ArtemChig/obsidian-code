// Minimal, spec-following SSE reader (docs/research/llama-server.md §8.3 "SSE reader").

export interface SseEvent { event?: string; data: string }

/**
 * Parse SSE text incrementally. Feed decoded text; returns the events completed so far.
 * Lines starting with ':' are comments/pings. `data:` lines are joined with '\n'. A blank line dispatches.
 */
export class SseParser {
  private buf = '';
  private dataLines: string[] = [];
  private eventName: string | undefined;

  feed(text: string): SseEvent[] {
    this.buf += text;
    const out: SseEvent[] = [];
    let idx: number;
    // split on \n (strip a trailing \r) and keep the trailing partial line
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.line(line, out);
    }
    return out;
  }

  /** Flush at EOF: dispatch any pending data (and a final unterminated line). */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf.length) {
      const line = this.buf.endsWith('\r') ? this.buf.slice(0, -1) : this.buf;
      this.buf = '';
      this.line(line, out);
    }
    this.dispatch(out);
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === '') { this.dispatch(out); return; }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventName = value;
    // id:, retry: and unknown fields are ignored
  }

  private dispatch(out: SseEvent[]): void {
    if (this.dataLines.length) out.push({ event: this.eventName, data: this.dataLines.join('\n') });
    this.dataLines = [];
    this.eventName = undefined;
  }
}

/** Read a byte stream as SSE events. `onBytes` is called for every received chunk (idle-timeout reset). */
export async function* readSse(body: ReadableStream<Uint8Array>, onBytes?: () => void): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = new SseParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onBytes?.();
      if (value && value.length) {
        for (const ev of parser.feed(decoder.decode(value, { stream: true }))) yield ev;
      }
    }
    const tail = decoder.decode();
    if (tail) for (const ev of parser.feed(tail)) yield ev;
    for (const ev of parser.end()) yield ev;
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}
