// Keyboard shortcuts reference (palette → "Keyboard shortcuts", or Ctrl+/). Owner: ui-foundation.
// M13: reference keybind table — mono cap group headings, 28 px rows on --rule2 sub-hairlines, key caps on the right.
import { Dialog, DialogContent } from '@renderer/components/ui/dialog';
import { Kbd } from '@renderer/components/ui/kbd';
import { useUi } from '@renderer/state/ui';
import { SHORTCUTS } from './shortcuts';

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'App',
    rows: [
      [SHORTCUTS.palette, 'Command palette'],
      [SHORTCUTS.newSession, 'New session'],
      [SHORTCUTS.sidebar, 'Toggle sidebar'],
      [SHORTCUTS.rightPanel, 'Toggle side panel'],
      [SHORTCUTS.settings, 'Settings'],
      [SHORTCUTS.help, 'Keyboard shortcuts'],
    ],
  },
  {
    title: 'Sidebar (a focused session or group)',
    rows: [
      ['Enter', 'Open a session / fold a group'],
      ['F2', 'Rename'],
      ['Alt+↑', 'Move up'],
      ['Alt+↓', 'Move down'],
    ],
  },
  {
    title: 'Composer',
    rows: [
      ['Enter', 'Send (queues while the agent works)'],
      ['Shift+Enter', 'New line'],
      ['Shift+Tab', 'Cycle permission mode (Ask → Accept edits → Plan)'],
      ['/', 'Commands'],
      ['@', 'Mention a file'],
      ['↑', 'Recall the last message (empty composer)'],
      ['Esc', 'Stop the turn (queued messages return to the composer)'],
    ],
  },
  {
    title: 'Prompt cards (when the card has focus)',
    rows: [
      ['1 / 2 / 3', 'Choose an option (permission, question, plan)'],
      ['Enter', 'Submit answers'],
      ['Esc', 'Deny a permission request'],
    ],
  },
];

/** "Ctrl+Shift+K" → caps; "1 / 2 / 3" → three caps; a lone "+" stays a key. */
function keyCaps(k: string): string[] {
  if (k.includes(' / ')) return k.split(' / ');
  if (k.length > 1 && k.includes('+')) return k.split('+');
  return [k];
}

export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  return (
    <Dialog open={open} onOpenChange={(o) => useUi.setState({ shortcutsOpen: o })}>
      <DialogContent title="Keyboard shortcuts" size="md">
        <div className="flex flex-col gap-5 pb-2" data-testid="shortcuts-dialog">
          {GROUPS.map((g) => (
            <section key={g.title} className="flex flex-col">
              <h3 className="ob-cap border-b border-rule pb-2">{g.title}</h3>
              <dl className="flex flex-col">
                {g.rows.map(([k, label]) => (
                  <div key={`${g.title}:${k}`} className="flex min-h-7 items-center justify-between gap-4 border-b border-rule2 py-1 last:border-b-0">
                    <dt className="text-[12px] tracking-[-0.014em] text-t2">{label}</dt>
                    <dd className="flex shrink-0 items-center gap-[3px]">
                      {keyCaps(k).map((part, i) => (
                        <Kbd key={`${part}-${i}`}>{part}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
