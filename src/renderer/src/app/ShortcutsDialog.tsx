// Keyboard shortcuts reference (palette → "Keyboard shortcuts", or Ctrl+/). Owner: ui-foundation.
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

export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  return (
    <Dialog open={open} onOpenChange={(o) => useUi.setState({ shortcutsOpen: o })}>
      <DialogContent title="Keyboard shortcuts" size="md">
        <div className="flex flex-col gap-4 pb-2" data-testid="shortcuts-dialog">
          {GROUPS.map((g) => (
            <section key={g.title} className="flex flex-col gap-1.5">
              <h3 className="ob-section-label text-[10.5px]">{g.title}</h3>
              <dl className="flex flex-col">
                {g.rows.map(([k, label]) => (
                  <div key={`${g.title}:${k}`} className="flex h-8 items-center justify-between gap-4 border-b border-ob-border last:border-b-0">
                    <dt className="text-ui text-ob-text-2">{label}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {k.split(' / ').map((part) => (
                        <Kbd key={part}>{part}</Kbd>
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
