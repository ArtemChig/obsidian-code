// Session-level commands used by the command palette: export / copy the transcript as Markdown. Owner: ui-chat.
import { downloadText } from '@renderer/lib/bridge';
import { useSessions } from '@renderer/state/sessions';
import { loadTranscript } from '@renderer/state/sync';
import { toast } from '@renderer/state/toasts';
import { exportFileName, transcriptMarkdown } from './lib/export';

async function markdownFor(sessionId: string): Promise<{ title: string; markdown: string } | null> {
  await loadTranscript(sessionId);
  const st = useSessions.getState();
  const entry = st.transcripts[sessionId];
  const summary = st.sessions[sessionId] ?? entry?.session;
  if (!entry || !summary) {
    toast({ title: 'Could not export the session', body: st.loadErrors[sessionId] ?? 'The transcript is not loaded.', level: 'error' });
    return null;
  }
  return { title: summary.title, markdown: transcriptMarkdown(summary, entry.session.messages) };
}

export async function exportSessionMarkdown(sessionId: string): Promise<void> {
  const r = await markdownFor(sessionId);
  if (r) downloadText(exportFileName(r.title), r.markdown);
}

export async function copySessionMarkdown(sessionId: string): Promise<void> {
  const r = await markdownFor(sessionId);
  if (!r) return;
  try {
    await navigator.clipboard.writeText(r.markdown);
    toast({ title: 'Transcript copied', body: 'Markdown is on the clipboard.', level: 'success', durationMs: 2000 });
  } catch {
    toast({ title: 'Could not copy the transcript', level: 'error' });
  }
}
