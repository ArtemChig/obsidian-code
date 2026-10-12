// Plan approval card: rendered plan; approve with auto-accept edits or ask-before-edits; or keep planning + feedback.
// Keys: 1 / 2 approve, 3 keep planning. Owner: ui-chat.
import { ClipboardList, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PermissionMode, PlanRequest } from '@shared/types';
import { Button } from '@renderer/components/ui/button';
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

  return (
    <div
      ref={root}
      data-testid="plan-approval"
      data-request-id={request.requestId}
      role="group"
      aria-label="Plan approval"
      className={cn(
        'overflow-hidden rounded-[12px] border bg-ob-surface-1 animate-ob-slide-up',
        active ? 'border-[rgba(143,184,222,0.42)] shadow-[0_0_0_4px_rgba(143,184,222,0.05)]' : 'border-ob-border',
      )}
    >
      <div className="flex items-center gap-3 px-4 pt-3.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-ob-accent-soft text-ob-accent">
          <ClipboardList size={15} aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13.5px] font-medium text-ob-text">Ready to code?</span>
          <span className="text-small text-ob-text-3">Review the plan. Nothing has been changed yet.</span>
        </div>
      </div>

      <div className="mx-4 mt-3 max-h-[340px] overflow-y-auto rounded-[8px] border border-ob-border bg-ob-bg px-4 py-3" data-testid="plan-body">
        <Markdown text={request.plan} compact />
      </div>

      <div className="flex flex-col gap-1.5 px-4 pt-3">
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
          <div className="ml-[30px] flex flex-col gap-2 animate-ob-fade-in">
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

      <div className="flex items-center gap-1.5 px-4 pb-3 pt-2.5 text-meta text-ob-text-3">
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
