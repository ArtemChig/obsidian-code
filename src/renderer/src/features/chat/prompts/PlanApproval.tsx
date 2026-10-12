// Plan approval card: rendered plan; approve with auto-accept edits or ask-before-edits; or keep planning + feedback.
// Keys: 1 / 2 approve, 3 keep planning. Owner: ui-chat.
import { ClipboardList, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PermissionMode, PlanRequest } from '@shared/types';
import { Button } from '@renderer/components/ui/button';
import { StatusDot } from '@renderer/components/ui/feedback';
import { Textarea } from '@renderer/components/ui/input';
import { Kbd } from '@renderer/components/ui/kbd';
import { Markdown } from '@renderer/components/ui/markdown';
import { cn } from '@renderer/lib/cn';
import { respondPlan } from '@renderer/state/actions';
import { OptionRow } from '../ui';
import { digitOf, usePromptKeys } from './usePromptKeys';

export function PlanApproval({ request, active }: { request: PlanRequest; active: boolean }) {
  const root = useRef<HTMLDivElement | null>(null);
  const feedbackRef = useRef<HTMLTextAreaElement | null>(null);
  const [mode, setMode] = useState<'approve-edits' | 'approve-default' | 'keep' | null>(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);

  const approve = (m: PermissionMode) => {
    if (busy) return;
    setBusy(true);
    setMode(m === 'acceptEdits' ? 'approve-edits' : 'approve-default');
    void respondPlan(request.requestId, true, { mode: m }).then((ok) => {
      if (!ok) setBusy(false);
    });
  };

  const keepPlanning = () => {
    if (busy) return;
    setBusy(true);
    void respondPlan(request.requestId, false, { feedback: feedback.trim() || undefined }).then((ok) => {
      if (!ok) setBusy(false);
    });
  };

  const openFeedback = () => {
    setMode('keep');
    setTimeout(() => feedbackRef.current?.focus(), 0);
  };

  usePromptKeys(active && !busy, root, (e) => {
    const n = digitOf(e);
    if (n === 1) approve('acceptEdits');
    else if (n === 2) approve('default');
    else if (n === 3) openFeedback();
    else return false;
    return true;
  });

  useEffect(() => {
    root.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  // M13: actionable, not urgent → 1 px --line frame; the plan sits in an --s1 well; decisions as numbered rows.
  return (
    <div
      ref={root}
      data-testid="plan-approval"
      data-request-id={request.requestId}
      role="group"
      aria-label="Plan approval"
      tabIndex={-1}
      className={cn(
        'rounded-[2px] bg-s0 outline-none animate-ob-slide-up focus:outline-solid focus:outline-1 focus:outline-offset-2 focus:outline-acc',
        active ? 'shadow-[inset_0_0_0_1px_var(--line)]' : 'shadow-[inset_0_0_0_1px_var(--rule)]',
      )}
    >
      <div className="flex h-8 items-center gap-2.5 border-b border-rule px-4">
        <StatusDot tone="warning" pulse={active} size={6} />
        <span className="font-mono text-[9px] font-medium uppercase tracking-[0.22em] text-t1">Plan</span>
        <span className="font-mono text-[9px] text-t3" aria-hidden>
          ·
        </span>
        <span className="font-mono text-[9px] font-medium uppercase tracking-[0.22em] text-t3">Approval</span>
        <span className="flex-1" />
        <ClipboardList size={12} aria-hidden className="shrink-0 text-t3" />
      </div>

      <div className="flex flex-col gap-1 px-4 pt-3.5">
        <span className="text-lead font-semibold text-t1">Ready to code?</span>
        <span className="text-[11.5px] text-t3">Review the plan. Nothing has been changed yet.</span>
      </div>

      <div className="mx-4 mt-3 max-h-[340px] overflow-y-auto rounded-[2px] border border-rule bg-s1 px-4 py-3" data-testid="plan-body">
        <Markdown text={request.plan} compact />
      </div>

      <div className="mx-4 mt-3 flex flex-col border-t border-rule2">
        <OptionRow
          compact
          index={1}
          title="Yes, and auto-accept edits"
          description="Switches the session to Accept edits"
          selected={mode === 'approve-edits'}
          onSelect={() => approve('acceptEdits')}
          testId="plan-approve-edits"
        />
        <OptionRow
          compact
          index={2}
          title="Yes, and ask before each edit"
          description="Switches the session to Ask permissions"
          selected={mode === 'approve-default'}
          onSelect={() => approve('default')}
          testId="plan-approve-default"
        />
        <OptionRow
          compact
          index={3}
          title="No, keep planning"
          description="Tell the agent what to change"
          tone="warning"
          selected={mode === 'keep'}
          onSelect={openFeedback}
          testId="plan-keep"
        />
        {mode === 'keep' ? (
          <div className="ml-[42px] mt-2 flex flex-col gap-2 animate-ob-fade-in">
            <Textarea
              ref={feedbackRef}
              minRows={2}
              maxRows={8}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  keepPlanning();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setMode(null);
                }
              }}
              placeholder="What should the plan do differently?"
              aria-label="Plan feedback"
              data-testid="plan-feedback"
            />
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" icon={Send} loading={busy} onClick={keepPlanning} data-testid="plan-send-feedback">
                Send feedback
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5 px-4 pb-3 pt-3 font-mono text-[9px] uppercase tracking-[0.12em] text-t3">
        <Kbd>1</Kbd>
        <Kbd>2</Kbd>
        <span>approve</span>
        <span aria-hidden>·</span>
        <Kbd>3</Kbd>
        <span>keep planning</span>
      </div>
    </div>
  );
}
