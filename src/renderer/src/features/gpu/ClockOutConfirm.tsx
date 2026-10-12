// App-wide clock-out confirmation (rendered once in App): every clock-out entry point — sidebar widget, Home card,
// command palette, GPU view — goes through requestClockOut(), which parks a prompt here when clocking out would fail
// running turns or cancel a clock-in that already rented an instance. Owner: ui-views.
import { ConfirmDialog } from '@renderer/components/ui/dialog';
import { formatMoney, pluralize } from '@renderer/lib/format';
import { clockOut } from '@renderer/state/actions';
import { useGpu } from '@renderer/state/gpu';

export function GpuClockOutConfirm() {
  const prompt = useGpu((s) => s.confirm);
  const close = () => useGpu.setState({ confirm: null });
  const running = prompt?.sessions ?? [];
  const cancel = prompt?.kind === 'cancel';
  const description = cancel
    ? `The rented instance is destroyed and the setup so far is lost${prompt && prompt.spent > 0 ? ` (${formatMoney(prompt.spent)} spent)` : ''}. The next clock-in starts over, including the model download.`
    : `${pluralize(running.length, 'session')} ${running.length === 1 ? 'is' : 'are'} using the GPU model right now. The turn will fail when the instance goes away.`;
  return (
    <ConfirmDialog
      open={!!prompt}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      danger
      title={cancel ? 'Cancel the clock-in?' : 'Clock out while work is running?'}
      confirmLabel={cancel ? 'Cancel clock-in' : 'Clock out'}
      cancelLabel={cancel ? 'Keep going' : 'Keep running'}
      description={description}
      onConfirm={async () => {
        close();
        await clockOut();
      }}
    >
      {running.length ? (
        <ul className="flex flex-col border-t border-rule2 text-[12px] tracking-[-0.012em] text-t1" data-testid="gpu-confirm-sessions">
          {running.slice(0, 5).map((t, i) => (
            <li key={i} className="flex h-7 items-center gap-[9px] border-b border-rule2">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-live" />
              <span className="truncate">{t}</span>
            </li>
          ))}
          {running.length > 5 ? <li className="flex h-7 items-center font-mono text-[10px] text-t3">and {running.length - 5} more</li> : null}
        </ul>
      ) : null}
    </ConfirmDialog>
  );
}
