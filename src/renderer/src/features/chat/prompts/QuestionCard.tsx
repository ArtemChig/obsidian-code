// AskUserQuestion card: options as selectable rows (radio / multi-select), "Other…" free text, Submit.
// Keys: 1..n pick an option of the current question, Enter submits. Owner: ui-chat.
import { MessageCircleQuestionMark, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { QuestionRequest } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
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

  return (
    <div
      ref={root}
      data-testid="question-card"
      data-request-id={request.requestId}
      role="group"
      aria-label="Question from the agent"
      className={cn(
        'overflow-hidden rounded-[12px] border bg-ob-surface-1 animate-ob-slide-up',
        active ? 'border-[rgba(143,184,222,0.42)] shadow-[0_0_0_4px_rgba(143,184,222,0.05)]' : 'border-ob-border',
      )}
    >
      <div className="flex items-center gap-3 px-4 pt-3.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-ob-accent-soft text-ob-accent">
          <MessageCircleQuestionMark size={15} aria-hidden />
        </span>
        <div className="flex-1 text-[13.5px] font-medium text-ob-text">
          {request.questions.length > 1 ? `${request.questions.length} questions need your input` : 'The agent needs your input'}
        </div>
      </div>

      <div className="flex flex-col gap-4 px-4 pt-3">
        {request.questions.map((q, qi) => {
          const s = state[qi];
          return (
            <fieldset key={qi} className="flex min-w-0 flex-col gap-2" data-testid="question" aria-label={q.question}>
              <legend className="mb-2 flex flex-wrap items-center gap-2">
                {q.header ? (
                  <Badge tone="accent" mono>
                    {q.header}
                  </Badge>
                ) : null}
                <span className="text-ui text-ob-text">{q.question}</span>
                {q.multiSelect ? <span className="text-small text-ob-text-3">Select all that apply</span> : null}
              </legend>
              <div className="flex flex-col gap-1.5" role={q.multiSelect ? 'group' : 'radiogroup'}>
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
                    className="ml-[30px] w-[calc(100%-30px)]"
                    data-testid="question-other-input"
                  />
                ) : null}
              </div>
            </fieldset>
          );
        })}
      </div>

      <div className="flex items-center gap-2 px-4 pb-3.5 pt-3">
        <span className="flex items-center gap-1.5 text-meta text-ob-text-3">
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
