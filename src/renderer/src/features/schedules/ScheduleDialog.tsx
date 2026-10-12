// Create / edit dialog for a scheduled task. Owner: ui-views.
import { CalendarClock, FolderOpen, TriangleAlert } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { ModelRef, PermissionMode, ScheduledTask } from '@shared/types';
import { Button } from '@renderer/components/ui/button';
import { Dialog, DialogContent } from '@renderer/components/ui/dialog';
import { Field, Input, Textarea } from '@renderer/components/ui/input';
import { Select, type SelectGroupDef, type SelectOption } from '@renderer/components/ui/select';
import { Checkbox, Switch } from '@renderer/components/ui/toggles';
import { pickFolder } from '@renderer/lib/bridge';
import { formatMoney, modelKey, parseModelKey, relativeFuture } from '@renderer/lib/format';
import { cn } from '@renderer/lib/cn';
import { useGpu } from '@renderer/state/gpu';
import { useModels } from '@renderer/state/models';
import { useModelGroups } from '@renderer/state/selectors';
import { useSettings } from '@renderer/state/settings';
import { PERMISSION_MODES, permissionModeInfo } from '../settings/permission-modes';
import { createSchedule, updateSchedule } from './actions';
import {
  PRESET_LABEL,
  WEEKDAYS,
  buildSchedule,
  defaultScheduleForm,
  describeSchedule,
  nextRuns,
  parseSchedule,
  toLocalInput,
  type Preset,
  type ScheduleForm,
} from './cron';

export interface ScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this task; omit to create a new one. */
  task?: ScheduledTask | null;
}

export function ScheduleDialog({ open, onOpenChange, task }: ScheduleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <DialogBody key={task?.id ?? 'new'} task={task ?? null} onClose={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

// ───────────────────────────── Validation ─────────────────────────────

export interface FormState {
  name: string;
  prompt: string;
  cwd: string;
  schedule: ScheduleForm;
  /** modelKey(ref) or 'default'. */
  model: string;
  mode: PermissionMode;
  autoClockIn: boolean;
}

export type FormErrors = Partial<Record<'name' | 'prompt' | 'cwd' | 'schedule', string>>;

const ABS_PATH = /^([A-Za-z]:[\\/]|\\\\|\/)/;

export function validateForm(f: FormState, now = Date.now()): FormErrors {
  const e: FormErrors = {};
  const name = f.name.trim();
  if (!name) e.name = 'Give the schedule a name';
  else if (name.length > 80) e.name = 'Keep the name under 80 characters';
  if (!f.prompt.trim()) e.prompt = 'Write the prompt the agent should run';
  const cwd = f.cwd.trim();
  if (!cwd) e.cwd = 'Choose the folder the agent works in';
  else if (!ABS_PATH.test(cwd)) e.cwd = 'Use an absolute path, e.g. C:\\Projects\\app';
  const built = buildSchedule(f.schedule, now);
  if (!built.ok) e.schedule = built.error;
  return e;
}

function initialState(task: ScheduledTask | null, defaultCwd: string): FormState {
  if (!task) {
    return { name: '', prompt: '', cwd: defaultCwd, schedule: defaultScheduleForm(), model: 'default', mode: 'acceptEdits', autoClockIn: false };
  }
  return {
    name: task.name,
    prompt: task.prompt,
    cwd: task.cwd,
    schedule: parseSchedule(task.schedule, task.oneShot),
    model: task.model ? modelKey(task.model) : 'default',
    mode: task.permissionMode,
    autoClockIn: task.allowAutoClockIn,
  };
}

// ───────────────────────────── Body ─────────────────────────────

function DialogBody({ task, onClose }: { task: ScheduledTask | null; onClose: () => void }) {
  const editing = !!task;
  const defaultCwd = useSettings((s) => s.settings?.defaultCwd ?? '');
  const [form, setForm] = useState<FormState>(() => initialState(task, defaultCwd));
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const cwdRef = useRef<HTMLInputElement>(null);
  const groups = useModelGroups();
  const models = useModels((s) => s.models);

  const errors = useMemo(() => validateForm(form), [form]);
  const show = (k: keyof FormErrors): string | undefined => (submitted || touched.has(k) ? errors[k] : undefined);
  const touch = (k: string) => setTouched((t) => (t.has(k) ? t : new Set(t).add(k)));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setSched = (patch: Partial<ScheduleForm>) => setForm((f) => ({ ...f, schedule: { ...f.schedule, ...patch } }));

  const modelRef: ModelRef | null = form.model === 'default' ? null : parseModelKey(form.model);
  const isVast = modelRef?.provider === 'vast';

  const modelGroups = useMemo<SelectGroupDef[]>(() => {
    const out: SelectGroupDef[] = [{ label: 'Automatic', options: [{ value: 'default', label: 'Default model', description: 'Whatever the app default is when the task runs' }] }];
    const seen = new Set<string>();
    for (const g of groups) {
      const options: SelectOption[] = g.models.map((m) => {
        const key = modelKey(m.ref);
        seen.add(key);
        return { value: key, label: m.label, description: [m.variant, m.status === 'online' ? null : m.status].filter(Boolean).join(' · ') || undefined };
      });
      if (options.length) out.push({ label: g.provider.label, options });
    }
    if (task?.model && !seen.has(modelKey(task.model)) && !models.some((m) => modelKey(m.ref) === modelKey(task.model))) {
      out.push({ label: 'Saved', options: [{ value: modelKey(task.model), label: task.model.model, description: `${task.model.provider} (not currently listed)` }] });
    }
    return out;
  }, [groups, models, task]);

  const built = useMemo(() => buildSchedule(form.schedule), [form.schedule]);
  const preview = useMemo(() => {
    if (!built.ok) return null;
    return { words: describeSchedule(built.schedule, built.oneShot), runs: nextRuns(built.schedule, 3) };
  }, [built]);

  const submit = async () => {
    setSubmitted(true);
    const first = (['name', 'prompt', 'cwd'] as const).find((k) => errors[k]);
    if (first || errors.schedule) {
      if (first === 'name') nameRef.current?.focus();
      else if (first === 'prompt') promptRef.current?.focus();
      else if (first === 'cwd') cwdRef.current?.focus();
      return;
    }
    if (!built.ok) return;
    setSaving(true);
    const base = {
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      cwd: form.cwd.trim(),
      schedule: built.schedule,
      oneShot: built.oneShot,
      model: modelRef,
      permissionMode: form.mode,
      allowAutoClockIn: isVast && form.autoClockIn,
    };
    const saved = task ? await updateSchedule(task.id, base) : await createSchedule({ ...base, enabled: true });
    setSaving(false);
    if (saved) onClose();
  };

  const browse = async () => {
    const dir = await pickFolder(form.cwd || undefined);
    if (dir) {
      set('cwd', dir);
      touch('cwd');
    }
  };

  const modeInfo = permissionModeInfo(form.mode);

  return (
    <DialogContent
      size="lg"
      className="top-[5vh] max-h-[90vh]"
      title={editing ? 'Edit schedule' : 'New schedule'}
      description={editing ? undefined : 'Run a prompt on a schedule in its own session, even while you are away.'}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        nameRef.current?.focus();
      }}
      footer={
        <>
          {/* mousedown must not blur a field: its inline error would move the footer before the click lands */}
          <Button variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={onClose} data-testid="schedule-cancel">
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onMouseDown={(e) => e.preventDefault()} onClick={() => void submit()} data-testid="schedule-save">
            {editing ? 'Save changes' : 'Create schedule'}
          </Button>
        </>
      }
    >
      <form
        data-testid="schedule-dialog"
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" htmlFor="sch-name" error={show('name')}>
          <Input
            id="sch-name"
            ref={nameRef}
            data-testid="schedule-name"
            value={form.name}
            invalid={!!show('name')}
            maxLength={120}
            placeholder="Nightly dependency audit"
            onChange={(e) => set('name', e.target.value)}
            onBlur={() => touch('name')}
          />
        </Field>

        <Field label="Prompt" htmlFor="sch-prompt" error={show('prompt')} description={!show('prompt') ? 'Runs unattended: the agent cannot ask you questions while it works.' : undefined}>
          <Textarea
            id="sch-prompt"
            ref={promptRef}
            data-testid="schedule-prompt"
            value={form.prompt}
            invalid={!!show('prompt')}
            minRows={3}
            maxRows={10}
            placeholder="Run npm audit and summarize anything high or critical."
            onChange={(e) => set('prompt', e.target.value)}
            onBlur={() => touch('prompt')}
          />
        </Field>

        <Field label="Folder" htmlFor="sch-cwd" error={show('cwd')}>
          <div className="flex items-center gap-2">
            <Input
              id="sch-cwd"
              ref={cwdRef}
              data-testid="schedule-cwd"
              mono
              value={form.cwd}
              invalid={!!show('cwd')}
              placeholder="C:\Projects\my-app"
              wrapperClassName="flex-1"
              className="flex-1"
              onChange={(e) => set('cwd', e.target.value)}
              onBlur={() => touch('cwd')}
            />
            <Button variant="secondary" icon={FolderOpen} onClick={() => void browse()} data-testid="schedule-browse">
              Browse
            </Button>
          </div>
        </Field>

        {/* schedule */}
        <fieldset className="flex flex-col gap-2.5 rounded-card border border-ob-border bg-[rgba(0,0,0,0.12)] p-3.5" data-testid="schedule-when">
          <legend className="ob-section-label -ml-1 px-1">Schedule</legend>
          <div className="flex flex-wrap items-start gap-2">
            <Select
              aria-label="Schedule type"
              value={form.schedule.preset}
              onValueChange={(v) => setSched({ preset: v as Preset })}
              className="w-[168px]"
              options={(Object.keys(PRESET_LABEL) as Preset[]).map((p) => ({ value: p, label: PRESET_LABEL[p] }))}
            />
            <ScheduleInputs form={form.schedule} error={show('schedule')} setSched={setSched} onBlur={() => touch('schedule')} />
          </div>
          {form.schedule.preset === 'cron' ? (
            <Checkbox checked={form.schedule.runOnce} onCheckedChange={(v) => setSched({ runOnce: v })} label="Run once, then disable" />
          ) : null}
          {show('schedule') ? (
            <div role="alert" className="text-small text-ob-danger" data-testid="schedule-error">
              {show('schedule')}
            </div>
          ) : preview ? (
            <div className="flex flex-col gap-1 text-small" data-testid="schedule-preview">
              <div className="flex items-center gap-2 text-ob-text">
                <CalendarClock size={14} aria-hidden className="text-ob-accent" />
                <span className="font-medium">{preview.words}</span>
              </div>
              <div className="ob-tabular font-mono text-[11.5px] text-ob-text-3">
                {preview.runs.length === 0 ? 'Never runs again' : `Next: ${preview.runs.map(fmtRun).join('  ·  ')}`}
              </div>
            </div>
          ) : null}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Model" htmlFor="sch-model">
            <Select id="sch-model" aria-label="Model" value={form.model} onValueChange={(v) => set('model', v)} groups={modelGroups} />
          </Field>
          <Field label="Permissions" htmlFor="sch-mode">
            <Select
              id="sch-mode"
              aria-label="Permission mode"
              value={form.mode}
              onValueChange={(v) => set('mode', v as PermissionMode)}
              options={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label, description: m.description }))}
            />
          </Field>
        </div>
        <p className={cn('-mt-2 text-small', form.mode === 'bypassPermissions' ? 'text-ob-warning' : 'text-ob-text-3')} data-testid="schedule-mode-note">
          {form.mode === 'bypassPermissions' ? <TriangleAlert size={12} aria-hidden className="mr-1 inline align-[-1px]" /> : null}
          {modeInfo.unattended}
        </p>

        <AutoClockIn checked={form.autoClockIn && isVast} disabled={!isVast} onChange={(v) => set('autoClockIn', v)} />
      </form>
    </DialogContent>
  );
}

function fmtRun(ts: number): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${date} ${time} (${relativeFuture(ts - Date.now())})`;
}

// ───────────────────────────── Schedule inputs per preset ─────────────────────────────

function ScheduleInputs({ form, error, setSched, onBlur }: { form: ScheduleForm; error?: string; setSched: (p: Partial<ScheduleForm>) => void; onBlur: () => void }) {
  const invalid = !!error;
  switch (form.preset) {
    case 'hours':
      return (
        <div className="flex items-center gap-2">
          <Input
            aria-label="Hours between runs"
            data-testid="schedule-hours"
            className="w-[72px] text-center"
            inputMode="numeric"
            value={form.everyHours}
            invalid={invalid}
            onChange={(e) => setSched({ everyHours: e.target.value })}
            onBlur={onBlur}
          />
          <span className="text-ui text-ob-text-2">{form.everyHours === '1' ? 'hour' : 'hours'}</span>
        </div>
      );
    case 'daily':
    case 'weekdays':
      return <Input aria-label="Time" data-testid="schedule-time" type="time" className="w-[120px]" value={form.time} invalid={invalid} onChange={(e) => setSched({ time: e.target.value })} onBlur={onBlur} />;
    case 'weekly':
      return (
        <>
          <Select
            aria-label="Day of the week"
            value={form.weekday}
            onValueChange={(v) => setSched({ weekday: v })}
            className="w-[136px]"
            options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))}
          />
          <Input aria-label="Time" data-testid="schedule-time" type="time" className="w-[120px]" value={form.time} invalid={invalid} onChange={(e) => setSched({ time: e.target.value })} onBlur={onBlur} />
        </>
      );
    case 'cron':
      return (
        <Input
          aria-label="Cron expression"
          data-testid="schedule-cron"
          mono
          wrapperClassName="min-w-[220px] flex-1"
          className="flex-1"
          value={form.cron}
          invalid={invalid}
          placeholder="0 9 * * 1-5"
          spellCheck={false}
          onChange={(e) => setSched({ cron: e.target.value })}
          onBlur={onBlur}
        />
      );
    case 'once':
      return (
        <Input
          aria-label="Date and time"
          data-testid="schedule-once"
          type="datetime-local"
          className="w-[220px]"
          min={toLocalInput(Date.now())}
          value={form.onceAt}
          invalid={invalid}
          onChange={(e) => setSched({ onceAt: e.target.value })}
          onBlur={onBlur}
        />
      );
  }
}

// ───────────────────────────── Auto clock-in ─────────────────────────────

function AutoClockIn({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  const profile = useSettings((s) => s.settings?.vast.profiles.find((p) => p.id === 'standard'));
  const budget = useGpu((s) => (s.status ? Math.max(0, s.status.monthlyBudget - s.status.monthCost) : null));
  return (
    <div className={cn('flex flex-col gap-2 rounded-card border p-3.5', checked ? 'border-[rgba(232,184,92,0.4)] bg-ob-warning-soft' : 'border-ob-border bg-[rgba(0,0,0,0.12)]')} data-testid="schedule-autoclockin">
      <Field
        inline
        label="Allow auto clock-in"
        htmlFor="sch-autoclock"
        description={disabled ? 'Only applies when the model runs on the Vast GPU. Pick a Vast model above to enable it.' : 'If the GPU is off when this runs, rent one automatically and clock out afterwards.'}
      >
        <Switch id="sch-autoclock" aria-label="Allow auto clock-in" checked={checked} disabled={disabled} onCheckedChange={onChange} />
      </Field>
      {checked ? (
        <div className="flex items-start gap-2 text-small text-ob-text" data-testid="schedule-cost-warning">
          <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0 text-ob-warning" />
          <span>
            This spends real money while you are away. Each run rents the Standard GPU
            {profile ? ` (up to ${formatMoney(profile.maxPricePerHour)}/h)` : ''}, pays for the model download (about 5–15 minutes, billed) and clocks out when the run ends.
            {budget != null ? ` It stops when the monthly budget is used up — ${formatMoney(budget)} left.` : ' The monthly budget still applies.'}
          </span>
        </div>
      ) : null}
    </div>
  );
}

