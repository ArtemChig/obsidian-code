// AskUserQuestion card: options as selectable rows (radio / multi-select), "Other…" free text, Submit.
// Keys: 1..n pick an option of the current question, Enter submits. Owner: ui-chat.
import { MessageCircleQuestionMark, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { QuestionRequest } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { StatusDot } from '@renderer/components/ui/feedback';
import { Input } from '@renderer/components/ui/input';
import { Kbd } from '@renderer/components/ui/kbd';
import { cn } from '@renderer/lib/cn';
import { answerQuestion } from '@renderer/state/actions';
import { answerFor, type QState } from '../lib/prompts';
import { OptionRow } from '../ui';
import { digitOf, usePromptKeys } from './usePromptKeys';

export function QuestionCard({ request, active }: { request: QuestionRequest; active: boolean }) {
  const root = useRef<HTMLDivElement | null>(null);
  const otherRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [state, setState] = useState<QState[]>(() => request.questions.map(() => ({ picked: [], otherOn: false, other: '' })));
  const [busy, setBusy] = useState(false);
  const answers = useMemo(() => request.questions.map((q, i) => answerFor(q, state[i])), [request.questions, state]);
  const complete = answers.every((a) => a !== '');
  const current = Math.max(0, answers.findIndex((a) => a === ''));
  const currentIdx = complete ? request.questions.length - 1 : current;

  const update = (qi: number, fn: (s: QState) => QState) => setState((all) => all.map((s, i) => (i === qi ? fn(s) : s)));

  const pick = (qi: number, label: string) => {
    const q = request.questions[qi];
    update(qi, (s) =>
      q.multiSelect
        ? { ...s, picked: s.picked.includes(label) ? s.picked.filter((l) => l !== label) : [...s.picked, label] }
        : { ...s, picked: [label], otherOn: false },
    );
  };

  const toggleOther = (qi: number) => {
    const q = request.questions[qi];
    update(qi, (s) => (q.multiSelect ? { ...s, otherOn: !s.otherOn } : { ...s, otherOn: true, picked: [] }));
    setTimeout(() => otherRefs.current[qi]?.focus(), 0);
  };

  const submit = () => {
    if (!complete || busy) return;
    setBusy(true);
    const out: Record<string, string> = {};
    request.questions.forEach((q, i) => {
      out[q.question] = answers[i];
    });
    void answerQuestion(request.requestId, out).then((ok) => {
      if (!ok) setBusy(false);
    });
  };

  usePromptKeys(active && !busy, root, (e) => {
    const n = digitOf(e);
    const q = request.questions[currentIdx];
    if (n && q) {
      if (n <= q.options.length) pick(currentIdx, q.options[n - 1].label);
      else if (n === q.options.length + 1) toggleOther(currentIdx);
      else return false;
      return true;
    }
    if (e.key === 'Enter' && complete) {
      submit();
      return true;
    }
    return false;
  });

  useEffect(() => {
    root.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  // M13: an actionable block waiting on the user → 1 px --warn frame, mono heading, options as numbered rows.
  return (
    <div
      ref={root}
      data-testid="question-card"
      data-request-id={request.requestId}
      role="group"
      aria-label="Question from the agent"
      tabIndex={-1}
      className={cn(
        'rounded-[2px] bg-s0 outline-none animate-ob-slide-up focus:outline-solid focus:outline-1 focus:outline-offset-2 focus:outline-warn',
        active ? 'shadow-[inset_0_0_0_1px_var(--warn)]' : 'shadow-[inset_0_0_0_1px_var(--line)]',
      )}
    >
      <div className="flex h-8 items-center gap-2.5 border-b border-rule px-4">
        <StatusDot tone="warning" pulse={active} size={6} />
        <span className="font-mono text-[9px] font-medium uppercase tracking-[0.22em] text-warn">Question</span>
        {request.questions.length > 1 ? (
          <>
            <span className="font-mono text-[9px] text-t3" aria-hidden>
              ·
            </span>
            <span className="font-mono text-[9px] font-medium uppercase tracking-[0.22em] text-t1">
              {currentIdx + 1} of {request.questions.length}
            </span>
          </>
        ) : null}
        <span className="flex-1" />
        <MessageCircleQuestionMark size={12} aria-hidden className="shrink-0 text-t3" />
      </div>

      <div className="px-4 pt-3.5 text-lead font-semibold text-t1">
        {request.questions.length > 1 ? `${request.questions.length} questions need your input` : 'The agent needs your input'}
      </div>

      <div className="flex flex-col gap-5 px-4 pt-3">
        {request.questions.map((q, qi) => {
          const s = state[qi];
          return (
            <fieldset key={qi} className="flex min-w-0 flex-col" data-testid="question" aria-label={q.question}>
              <legend className="mb-2.5 flex flex-wrap items-center gap-2.5">
                {q.header ? <Badge variant="outline">{q.header}</Badge> : null}
                <span className="text-[12.5px] tracking-[-0.012em] text-t1">{q.question}</span>
                {q.multiSelect ? <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-t3">Select all that apply</span> : null}
              </legend>
              <div className="flex flex-col border-t border-rule2" role={q.multiSelect ? 'group' : 'radiogroup'}>
                {q.options.map((o, oi) => (
                  <OptionRow
                    key={o.label}
                    index={oi + 1}
                    kind={q.multiSelect ? 'check' : 'radio'}
                    title={o.label}
                    description={o.description || undefined}
                    selected={s.picked.includes(o.label)}
                    onSelect={() => pick(qi, o.label)}
                    testId="question-option"
                  />
                ))}
                <OptionRow
                  index={q.options.length + 1}
                  kind={q.multiSelect ? 'check' : 'radio'}
                  title="Other…"
                  description={s.otherOn ? undefined : 'Type your own answer'}
                  selected={s.otherOn}
                  onSelect={() => toggleOther(qi)}
                  testId="question-other"
                />
                {s.otherOn ? (
                  <Input
                    ref={(el) => {
                      otherRefs.current[qi] = el;
                    }}
                    size="sm"
                    value={s.other}
                    onChange={(e) => update(qi, (st) => ({ ...st, other: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        submit();
                      }
                    }}
                    placeholder="Your answer"
                    aria-label={`Other answer for: ${q.question}`}
                    className="ml-[42px] mt-2 w-[calc(100%-42px)]"
                    data-testid="question-other-input"
                  />
                ) : null}
              </div>
            </fieldset>
          );
        })}
      </div>

      <div className="flex items-center gap-2 px-4 pb-3.5 pt-3.5">
        <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-t3">
          <Kbd>1</Kbd>–<Kbd>{(request.questions[currentIdx]?.options.length ?? 2) + 1}</Kbd> to pick · <Kbd>Enter</Kbd> to submit
        </span>
        <span className="flex-1" />
        <Button variant="primary" size="md" icon={Send} disabled={!complete} loading={busy} onClick={submit} data-testid="question-submit">
          Submit
        </Button>
      </div>
    </div>
  );
}
