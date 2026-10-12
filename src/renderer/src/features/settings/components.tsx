// Building blocks shared by the Settings sections. Owner: ui-views.
import { Check, CircleAlert, KeyRound, Lock, Plus, RotateCcw, Trash2, WandSparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge } from '@renderer/components/ui/badge';
import { Button, IconButton } from '@renderer/components/ui/button';
import { ConfirmDialog } from '@renderer/components/ui/dialog';
import { Input, Textarea } from '@renderer/components/ui/input';
import { cn } from '@renderer/lib/cn';
import { rpc } from '@renderer/lib/rpc';
import { setSecret } from '@renderer/state/actions';
import { useSettings } from '@renderer/state/settings';
import { toast } from '@renderer/state/toasts';
import { SAVED_TOAST_ID } from './save';
import { parseJson, validateNumber, validateRule } from './validate';

export { SAVED_TOAST_ID, patchLocal, patchPermissions, patchSearch, patchVast, saveSettings } from './save';

// ───────────────────────────── Layout ─────────────────────────────

export function Section({ id, title, description, children, actions }: { id: string; title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section aria-labelledby={`settings-h-${id}`} data-testid={`settings-section-${id}`} className="flex flex-col gap-5">
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={`settings-h-${id}`} className="text-[18px] font-semibold leading-6 text-ob-text">
            {title}
          </h2>
          {description ? <p className="max-w-[560px] text-ui text-ob-text-3">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** A titled card holding rows (divided) or free content. */
export function Group({ title, description, children, actions, testId, className, flush }: { title?: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode; testId?: string; className?: string; flush?: boolean }) {
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {title || actions ? (
        <div className="flex items-end justify-between gap-3 px-0.5">
          <div className="flex min-w-0 flex-col">
            {title ? <h3 className="ob-section-label">{title}</h3> : null}
            {description ? <p className="mt-1 text-small text-ob-text-3">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn('rounded-card border border-ob-border bg-ob-surface-1', flush ? '' : 'divide-y divide-ob-border', className)}>{children}</div>
    </div>
  );
}

/** Label + description on the left, control on the right (or below when `stacked`). */
export function Row({ label, description, htmlFor, children, stacked, testId, className }: { label: ReactNode; description?: ReactNode; htmlFor?: string; children?: ReactNode; stacked?: boolean; testId?: string; className?: string }) {
  return (
    <div className={cn('flex gap-6 px-4 py-3.5', stacked ? 'flex-col gap-2.5' : 'items-center justify-between', className)} data-testid={testId}>
      <div className={cn('flex min-w-0 flex-col gap-0.5', !stacked && 'max-w-[460px]')}>
        <label htmlFor={htmlFor} className="text-ui font-medium text-ob-text">
          {label}
        </label>
        {description ? <div className="text-small leading-[1.45] text-ob-text-3">{description}</div> : null}
      </div>
      {children !== undefined ? <div className={cn(stacked ? 'min-w-0' : 'shrink-0')}>{children}</div> : null}
    </div>
  );
}

export function InlineError({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cn('mt-1 flex items-start gap-1 text-small text-ob-danger', className)}>
      <CircleAlert size={12} aria-hidden className="mt-[3px] shrink-0" />
      <span>{children}</span>
    </div>
  );
}

// ───────────────────────────── Number & text fields (commit on blur / Enter) ─────────────────────────────

export interface NumberFieldProps {
  id?: string;
  value: number;
  onCommit: (n: number) => void | Promise<unknown>;
  min?: number;
  max?: number;
  integer?: boolean;
  unit?: string;
  prefix?: string;
  width?: string;
  disabled?: boolean;
  'aria-label'?: string;
  testId?: string;
}

export function NumberField({ id, value, onCommit, min, max, integer, unit, prefix, width = 'w-[96px]', disabled, testId, ...aria }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) {
      setDraft(String(value));
      setError(null);
    }
  }, [value]);

  const commit = () => {
    const r = validateNumber(draft, { min, max, integer });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    if (r.value !== value) void onCommit(r.value);
    else setDraft(String(value));
  };

  return (
    <div className="relative flex flex-col items-end">
      <div className="flex items-center gap-2">
        {prefix ? <span className="text-ui text-ob-text-3">{prefix}</span> : null}
        <Input
          id={id}
          aria-label={aria['aria-label']}
          data-testid={testId}
          inputMode="decimal"
          mono
          className={cn(width, 'text-right')}
          value={draft}
          disabled={disabled}
          invalid={!!error}
          onFocus={() => (focused.current = true)}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setDraft(String(value));
              setError(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {unit ? <span className="min-w-[2.5rem] text-ui text-ob-text-3">{unit}</span> : null}
      </div>
      {/* absolutely positioned: an error that appears on blur must not shift the controls below it */}
      {error ? <InlineError className="absolute right-0 top-full z-10 whitespace-nowrap">{error}</InlineError> : null}
    </div>
  );
}

export interface TextFieldProps {
  id?: string;
  value: string;
  onCommit: (v: string) => void | Promise<unknown>;
  validate?: (v: string) => string | null;
  placeholder?: string;
  mono?: boolean;
  width?: string;
  disabled?: boolean;
  trailing?: ReactNode;
  /** Show the error in the layout flow instead of overlaying the padding below the field. */
  flowError?: boolean;
  'aria-label'?: string;
  testId?: string;
}

export function TextField({ id, value, onCommit, validate, placeholder, mono, width = 'w-full', disabled, trailing, flowError, testId, ...aria }: TextFieldProps) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
      setError(null);
    }
  }, [value]);

  const commit = () => {
    const err = validate ? validate(draft) : null;
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    const next = draft.trim();
    if (next !== value) void onCommit(next);
    else setDraft(value);
  };

  return (
    <div className={cn('relative flex min-w-0 flex-col', width)}>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          aria-label={aria['aria-label']}
          data-testid={testId}
          mono={mono}
          wrapperClassName="flex-1"
          className="flex-1"
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          invalid={!!error}
          spellCheck={false}
          onFocus={() => (focused.current = true)}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setDraft(value);
              setError(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {trailing}
      </div>
      {error ? <InlineError className={flowError ? undefined : 'absolute left-0 top-full z-10'}>{error}</InlineError> : null}
    </div>
  );
}

// ───────────────────────────── Secrets (presence only, never the value) ─────────────────────────────

/** Presence of named secrets: fetches names the store does not know yet. */
export function useSecretPresence(names: string[]): Record<string, boolean> {
  const secrets = useSettings((s) => s.secrets);
  const key = names.join('|');
  useEffect(() => {
    const missing = key.split('|').filter((n) => n && !(n in useSettings.getState().secrets));
    if (missing.length === 0) return;
    let alive = true;
    rpc
      .request('secrets.has', { names: missing })
      .then((r) => alive && useSettings.setState((s) => ({ secrets: { ...s.secrets, ...r } })))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key]);
  return secrets;
}

export function SecretPresence({ present }: { present: boolean | undefined }) {
  return present ? (
    <Badge tone="success" icon={Lock} data-testid="secret-present">
      Saved
    </Badge>
  ) : (
    <Badge tone="neutral" data-testid="secret-missing">
      Not set
    </Badge>
  );
}

export interface SecretFieldProps {
  /** Secret name, e.g. 'vast.apiKey' or 'custom.<id>.apiKey'. */
  name: string;
  placeholder?: string;
  /** Called after a successful save/removal. */
  onChanged?: (present: boolean) => void;
  extra?: ReactNode;
  testId?: string;
  /** Removal is not allowed right now (the reason is shown instead of the Remove button). */
  removeBlocked?: string;
  /** Replacing the saved key needs an explicit confirmation (the warning is shown in the dialog). */
  replaceWarning?: string;
}

/** Write-only input for a secret: shows presence, never the value. Removal (and risky replacement) asks first. */
export function SecretField({ name, placeholder = 'Paste a new key…', onChanged, extra, testId, removeBlocked, replaceWarning }: SecretFieldProps) {
  const present = useSecretPresence([name])[name];
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'remove' | 'replace' | null>(null);

  const requestSave = () => {
    if (!value.trim()) return;
    if (present && replaceWarning) setConfirm('replace');
    else void save();
  };
  const save = async () => {
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    const ok = await setSecret(name, v);
    setBusy(false);
    if (ok) {
      setValue('');
      toast({ id: SAVED_TOAST_ID, title: 'Key saved', body: 'Stored encrypted. It is never shown again.', level: 'success', durationMs: 2500 });
      onChanged?.(true);
    }
  };
  const remove = async () => {
    if (removeBlocked) return;
    setBusy(true);
    const ok = await setSecret(name, null);
    setBusy(false);
    if (ok) {
      toast({ id: SAVED_TOAST_ID, title: 'Key removed', level: 'info', durationMs: 2000 });
      onChanged?.(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid={testId ?? `secret-${name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          autoComplete="new-password"
          aria-label={`${name} (write only)`}
          data-testid={`${testId ?? `secret-${name}`}-input`}
          icon={KeyRound}
          mono
          wrapperClassName="min-w-[240px] flex-1"
          className="flex-1"
          placeholder={present ? '•••••••• (saved) — paste to replace' : placeholder}
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              requestSave();
            }
          }}
        />
        <Button variant="primary" loading={busy} disabled={!value.trim()} data-testid={`${testId ?? `secret-${name}`}-save`} onClick={requestSave}>
          Save key
        </Button>
        {present ? (
          <Button
            variant="ghost"
            disabled={busy || !!removeBlocked}
            title={removeBlocked}
            icon={Trash2}
            data-testid={`${testId ?? `secret-${name}`}-remove`}
            onClick={() => setConfirm('remove')}
          >
            Remove
          </Button>
        ) : null}
        {extra}
      </div>
      <div className="flex items-center gap-2 text-small text-ob-text-3">
        <SecretPresence present={present} />
        <span>{present ? 'Stored encrypted on this PC. It cannot be displayed again.' : 'Nothing stored yet.'}</span>
      </div>
      {present && removeBlocked ? (
        <div className="flex items-start gap-1.5 text-small text-ob-warning" data-testid={`${testId ?? `secret-${name}`}-locked`}>
          <CircleAlert size={13} aria-hidden className="mt-[2px] shrink-0" />
          <span>{removeBlocked}</span>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        danger
        title={confirm === 'replace' ? 'Replace the saved key?' : 'Remove the saved key?'}
        description={
          confirm === 'replace'
            ? (replaceWarning ?? '')
            : 'Features that use it stop working until you paste a key again. The key cannot be recovered from this app.'
        }
        confirmLabel={confirm === 'replace' ? 'Replace key' : 'Remove key'}
        onConfirm={async () => {
          if (confirm === 'replace') await save();
          else await remove();
        }}
      />
    </div>
  );
}

// ───────────────────────────── JSON editor ─────────────────────────────

const pretty = (v: unknown): string => JSON.stringify(v, null, 2);

export interface JsonEditorProps<T> {
  /** The saved value. */
  value: T;
  /** Problems with a parsed value (empty = valid). */
  validate: (parsed: unknown) => string[];
  onApply: (parsed: T) => Promise<boolean> | boolean;
  example?: T;
  testId: string;
  minRows?: number;
  /** Shown above the editor when the saved value is empty. */
  hint?: ReactNode;
}

export function JsonEditor<T>({ value, validate, onApply, example, testId, minRows = 10, hint }: JsonEditorProps<T>) {
  const saved = useMemo(() => pretty(value), [value]);
  const [text, setText] = useState(saved);
  const [saving, setSaving] = useState(false);
  const dirty = text !== saved;

  // Follow outside changes (settings.updated) while the user has no pending edit.
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (saved !== lastSaved.current) {
      if (text === lastSaved.current) setText(saved);
      lastSaved.current = saved;
    }
  }, [saved, text]);

  const result = useMemo(() => {
    const parsed = parseJson(text);
    if (!parsed.ok) return { ok: false as const, errors: [parsed.error], syntax: true };
    const errors = validate(parsed.value);
    return errors.length ? { ok: false as const, errors, syntax: false } : { ok: true as const, value: parsed.value as T };
  }, [text, validate]);

  const apply = async () => {
    if (!result.ok) return;
    setSaving(true);
    const ok = await onApply(result.value);
    setSaving(false);
    if (ok) setText(pretty(result.value));
  };

  return (
    <div className="flex flex-col gap-2.5" data-testid={testId}>
      {hint ? <div className="text-small text-ob-text-3">{hint}</div> : null}
      <Textarea
        aria-label="JSON"
        data-testid={`${testId}-text`}
        mono
        wrap="off"
        spellCheck={false}
        minRows={minRows}
        maxRows={26}
        invalid={!result.ok && dirty}
        className="overflow-x-auto whitespace-pre text-[12px] leading-[1.6]"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {!result.ok ? (
        <ul className="flex flex-col gap-1" data-testid={`${testId}-errors`} role="alert">
          {result.errors.slice(0, 8).map((e, i) => (
            <li key={i} className="flex items-start gap-1.5 text-small text-ob-danger">
              <CircleAlert size={12} aria-hidden className="mt-[3px] shrink-0" />
              <span className="min-w-0 break-words">{e}</span>
            </li>
          ))}
          {result.errors.length > 8 ? <li className="pl-[18px] text-small text-ob-text-3">and {result.errors.length - 8} more</li> : null}
        </ul>
      ) : (
        <div className="flex items-center gap-1.5 text-small text-ob-text-3" data-testid={`${testId}-status`}>
          {dirty ? (
            <>
              <span className="size-1.5 rounded-full bg-ob-warning" /> Unsaved changes
            </>
          ) : (
            <>
              <Check size={12} aria-hidden className="text-ob-success" /> Saved and valid
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" loading={saving} disabled={!dirty || !result.ok} data-testid={`${testId}-save`} onClick={() => void apply()}>
          Save
        </Button>
        <Button variant="ghost" icon={RotateCcw} disabled={!dirty} onClick={() => setText(saved)}>
          Revert
        </Button>
        <Button variant="ghost" icon={WandSparkles} disabled={!result.ok || text === pretty(result.ok ? result.value : null)} onClick={() => result.ok && setText(pretty(result.value))}>
          Format
        </Button>
        {example !== undefined ? (
          <Button variant="ghost" icon={Plus} className="ml-auto" data-testid={`${testId}-example`} onClick={() => setText(pretty(example))}>
            Insert example
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ───────────────────────────── Rule list (permissions) ─────────────────────────────

export function RuleList({ rules, onChange, tone, placeholder, testId, empty, validate = validateRule, itemLabel = 'rule' }: { rules: string[]; onChange: (rules: string[]) => Promise<boolean> | void; tone: 'allow' | 'deny'; placeholder: string; testId: string; empty: string; validate?: (value: string) => string | null; itemLabel?: string }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const r = draft.trim();
    const err = validate(r) ?? (rules.includes(r) ? `That ${itemLabel} is already in the list` : null);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setDraft('');
    await onChange([...rules, r]);
  };

  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <div className="flex flex-col px-4 pt-3.5">
        <div className="flex items-center gap-2">
          <Input
            aria-label={`Add ${tone} ${itemLabel}`}
            data-testid={`${testId}-input`}
            mono
            wrapperClassName="flex-1"
            className="flex-1"
            placeholder={placeholder}
            value={draft}
            invalid={!!error}
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void add();
              }
            }}
          />
          <Button variant="secondary" icon={Plus} data-testid={`${testId}-add`} onClick={() => void add()}>
            Add
          </Button>
        </div>
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
      {rules.length === 0 ? (
        <div className="px-4 pb-4 text-small text-ob-text-3">{empty}</div>
      ) : (
        <ul className="flex flex-col border-t border-ob-border" data-testid={`${testId}-list`}>
          {rules.map((r) => (
            <li key={r} className="group flex items-center gap-2 border-b border-ob-border px-4 py-1.5 last:border-b-0 hover:bg-ob-hover" data-testid={`${testId}-rule`}>
              <span className={cn('size-1.5 shrink-0 rounded-full', tone === 'allow' ? 'bg-ob-success' : 'bg-ob-danger')} aria-hidden />
              <code className="ob-selectable min-w-0 flex-1 truncate font-mono text-[12px] text-ob-text" title={r}>
                {r}
              </code>
              <IconButton label={`Remove ${r}`} icon={X} size="sm" onClick={() => void onChange(rules.filter((x) => x !== r))} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
