// First-run setup (owner: ui-views): shown once on a fresh install — no Vast.ai key saved and setup not finished.
// Steps: welcome → Vast.ai key (test shows the credit) → budget + default GPU → optional local llama-server → done.
// Everything here is also in Settings; "Skip setup" marks it done without changing anything.
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, CircleAlert, CircleCheck, Cpu, FlaskConical, Server, Wallet } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { RpcResult } from '@shared/protocol';
import type { GpuProfile } from '@shared/types';
import { AppMark } from '@renderer/components/ui/app-mark';
import { Button } from '@renderer/components/ui/button';
import { Spinner } from '@renderer/components/ui/feedback';
import { Switch } from '@renderer/components/ui/toggles';
import { openExternal } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { formatMoney } from '@renderer/lib/format';
import { errorMessage, rpc } from '@renderer/lib/rpc';
import { useConnection } from '@renderer/state/connection';
import { useGpu } from '@renderer/state/gpu';
import { useSettings } from '@renderer/state/settings';
import { NumberField, SecretField, TextField, patchLocal, patchVast, saveSettings } from '@renderer/features/settings/components';

const VAST_SIGNUP_URL = 'https://cloud.vast.ai/';
const VAST_KEYS_URL = 'https://cloud.vast.ai/manage-keys/';
const FORCED = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('setup');
let forcedClosed = false;
const STEPS = ['Welcome', 'Vast.ai key', 'Budget & GPU', 'This PC', 'Done'] as const;

/** Show the wizard: connected to a real core, settings loaded, setup not finished and no Vast.ai key saved yet. */
export function useSetupNeeded(): boolean {
  const mode = useConnection((c) => c.mode);
  const settings = useSettings((s) => s.settings);
  const hasKey = useGpu((s) => s.hasApiKey);
  // `?setup` shows it anyway (demo mode, screenshots) until it is finished or skipped once.
  if (FORCED) return !!settings && !forcedClosed;
  return mode === 'core' && !!settings && settings.setupDone !== true && hasKey === false;
}

export function SetupWizard() {
  const needed = useSetupNeeded();
  const [step, setStep] = useState(0);
  const [, rerender] = useState(0);
  if (!needed) return null;
  const finish = () => {
    forcedClosed = true;
    rerender((n) => n + 1);
    void saveSettings({ setupDone: true }, 'Setup finished');
  };
  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  return (
    <div role="dialog" aria-modal="true" aria-label="Set up Obsidian Code" data-testid="setup-wizard" className="fixed inset-0 z-50 flex flex-col bg-s0">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-rule px-6">
        <AppMark size={14} />
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-brand text-t1">Obsidian Code</span>
        <span className="ob-cap ml-3">Setup</span>
        <ol className="ml-auto hidden items-center gap-4 md:flex" aria-label="Setup steps">
          {STEPS.map((label, i) => (
            <li key={label} className={cn('flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-label', i === step ? 'text-t1' : i < step ? 'text-t2' : 'text-t3')} aria-current={i === step ? 'step' : undefined}>
              {i < step ? <Check size={10} aria-hidden className="text-ok" /> : <span className="ob-tabular">{i + 1}</span>}
              {label}
            </li>
          ))}
        </ol>
        {step < STEPS.length - 1 ? (
          <Button variant="ghost" size="sm" className="ml-4" data-testid="setup-skip" onClick={finish}>
            Skip setup
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[640px] flex-col gap-6 px-6 py-12">
          {step === 0 ? <Welcome /> : null}
          {step === 1 ? <VastKeyStep /> : null}
          {step === 2 ? <BudgetStep /> : null}
          {step === 3 ? <LocalStep /> : null}
          {step === 4 ? <DoneStep /> : null}
          <div className="flex items-center gap-2 border-t border-rule2 pt-5">
            {step > 0 && step < STEPS.length - 1 ? (
              <Button variant="ghost" icon={ArrowLeft} onClick={back}>
                Back
              </Button>
            ) : null}
            <div className="flex-1" />
            {step < STEPS.length - 1 ? (
              <Button variant="primary" data-testid="setup-next" onClick={next}>
                {step === 0 ? 'Get started' : 'Next'}
                <ArrowRight size={13} aria-hidden />
              </Button>
            ) : (
              <Button variant="primary" data-testid="setup-finish" onClick={finish}>
                Open Obsidian Code
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepTitle({ icon: Icon, title, children }: { icon: typeof Cpu; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-t3">
        <Icon size={14} aria-hidden />
      </div>
      <h1 className="text-display font-semibold text-t1">{title}</h1>
      {children ? <p className="text-prose text-t2">{children}</p> : null}
    </div>
  );
}

function Field({ label, description, children }: { label: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t border-rule2 pt-4">
      <span className="ob-cap">{label}</span>
      {children}
      {description ? <p className="text-[11.5px] leading-[17px] text-t3">{description}</p> : null}
    </div>
  );
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button type="button" className="inline-flex items-center gap-0.5 text-t1 underline decoration-line underline-offset-2 hover:decoration-acc" onClick={() => openExternal(href)}>
      {children}
      <ArrowUpRight size={11} aria-hidden />
    </button>
  );
}

// ───────────────────────────── steps ─────────────────────────────

function Welcome() {
  return (
    <StepTitle icon={Cpu} title="Welcome to Obsidian Code">
      A coding agent that runs on open-weight models: it reads, plans, edits and runs code in your folders. The model runs on a GPU you rent by
      the hour on Vast.ai — you clock in when you start working and clock out when you are done — or on a model server on this PC. This takes
      about two minutes, and everything can be changed later in Settings.
    </StepTitle>
  );
}

type KeyTest = RpcResult<'gpu.testKey'>;

function VastKeyStep() {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<KeyTest | null>(null);
  const hasKey = useGpu((s) => s.hasApiKey);
  const test = async () => {
    setTesting(true);
    try {
      setResult(await rpc.request('gpu.testKey', {}));
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <StepTitle icon={Server} title="Connect your Vast.ai account">
        The app rents GPUs on your own Vast.ai account and pays from its credit. Create an account at <Link href={VAST_SIGNUP_URL}>cloud.vast.ai</Link>,
        add some credit (for example $10–25; the app shows the cost before every clock-in), then create an API key.
      </StepTitle>
      <Field
        label="Vast.ai API key"
        description={
          <>
            Create it at <Link href={VAST_KEYS_URL}>cloud.vast.ai → Keys</Link> with these permissions: instance read and write, user read and write
            (to register the app&rsquo;s SSH key), and misc (offer search). It is stored encrypted on this PC and never shown again. No key? Press
            Next to skip — you can add it later in Settings → Vast.ai, or use a model server on this PC.
          </>
        }
      >
        <SecretField
          name="vast.apiKey"
          testId="setup-vast-key"
          placeholder="Paste your Vast.ai API key…"
          onChanged={(present) => {
            setResult(null);
            if (present) void test();
          }}
          extra={
            <Button variant="secondary" icon={FlaskConical} loading={testing} disabled={!hasKey} onClick={() => void test()}>
              Test key
            </Button>
          }
        />
        {testing && !result ? (
          <div className="flex items-center gap-2 font-mono text-[9.5px] text-t3">
            <Spinner size={12} /> Checking with Vast.ai…
          </div>
        ) : null}
        {result ? (
          <div
            role="status"
            data-testid="setup-key-result"
            className={cn('flex items-start gap-[9px] rounded-[2px] px-3 py-[9px] text-[11.5px] text-t2', result.ok ? 'shadow-[inset_0_0_0_1px_var(--ok-edge)]' : 'shadow-[inset_0_0_0_1px_var(--err)]')}
          >
            {result.ok ? <CircleCheck size={13} aria-hidden className="mt-[2px] shrink-0 text-ok" /> : <CircleAlert size={13} aria-hidden className="mt-[2px] shrink-0 text-err" />}
            <span>
              {result.message}
              {result.ok && result.creditBalance != null ? (
                <>
                  {' '}
                  — credit <span className="ob-tabular font-mono text-t1">{formatMoney(result.creditBalance)}</span>
                </>
              ) : null}
            </span>
          </div>
        ) : null}
      </Field>
    </>
  );
}

function BudgetStep() {
  const v = useSettings((s) => s.settings?.vast);
  const defaultModel = useSettings((s) => s.settings?.defaultModel);
  if (!v) return null;
  const pickProfile = (p: GpuProfile) => void saveSettings({ defaultModel: { provider: 'vast', model: p.defaultModelId } }, `${p.label} is the default`);
  return (
    <>
      <StepTitle icon={Wallet} title="Budget and default GPU">
        Clock-in is blocked once this month&rsquo;s spend reaches the budget, and a running GPU is clocked out. The rented machine also destroys
        itself when it is idle, when this app stops sending heartbeats, or after {v.maxSessionHours} h — so a crash never leaves it billing.
      </StepTitle>
      <Field label="Monthly budget" description="Counted from the app's own spend records. Your Vast.ai credit is a second hard limit.">
        <div className="flex justify-start">
          <NumberField id="setup-budget" testId="setup-budget" value={v.monthlyBudget} min={1} max={100000} prefix="$" unit="/mo" onCommit={(n) => patchVast({ monthlyBudget: n }, 'Budget saved')} />
        </div>
      </Field>
      <Field label="Default GPU" description="New sessions use this GPU's default model; you can switch per session. Prices are typical Vast.ai rates and vary.">
        <div className="flex flex-col">
          {v.profiles.map((p) => {
            const on = defaultModel?.provider === 'vast' && defaultModel.model === p.defaultModelId;
            return (
              <button
                key={p.id}
                type="button"
                data-testid={`setup-profile-${p.id}`}
                aria-pressed={on}
                onClick={() => pickProfile(p)}
                className={cn('ob-transition flex items-start gap-3 border-b border-rule2 px-3 py-3 text-left', on ? 'ob-selected' : 'hover:bg-hov')}
              >
                <span className={cn('mt-[3px] flex size-3 shrink-0 items-center justify-center rounded-full border', on ? 'border-acc bg-acc' : 'border-line')} aria-hidden />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[12.5px] font-semibold text-t1">{p.label}</span>
                  <span className="text-[11.5px] text-t3">{p.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Field>
    </>
  );
}

function LocalStep() {
  const local = useSettings((s) => s.settings?.local);
  if (!local) return null;
  return (
    <>
      <StepTitle icon={Cpu} title="A model server on this PC (optional)">
        If you run llama-server (llama.cpp) or another OpenAI-compatible server on this PC, the app can use it for free, next to the rented GPUs.
        Leave this off if you only use Vast.ai.
      </StepTitle>
      <Field label="Local server">
        <div className="flex items-center gap-3">
          <Switch checked={local.enabled} onCheckedChange={(on) => void patchLocal({ enabled: on }, on ? 'Local server on' : 'Local server off')} aria-label="Use a local model server" />
          <span className="text-[12px] text-t2">{local.enabled ? 'Use a model server on this PC' : 'Off'}</span>
        </div>
      </Field>
      {local.enabled ? (
        <Field label="Server URL" description="The OpenAI-compatible base URL, e.g. http://127.0.0.1:8080 for llama-server.">
          <TextField id="setup-local-url" value={local.baseUrl} mono onCommit={(url) => void patchLocal({ baseUrl: url })} validate={(u) => (/^https?:\/\/\S+$/.test(u.trim()) ? null : 'Enter an http(s) URL')} />
        </Field>
      ) : null}
    </>
  );
}

function DoneStep() {
  const hasKey = useGpu((s) => s.hasApiKey);
  return (
    <StepTitle icon={Check} title="You are set up">
      {hasKey
        ? 'Press Clock in in the GPU panel at the bottom left to rent a GPU (the first start downloads the model, about 5–15 minutes), then start a session. Clock out when you are done — or right-click Clock out to let the app do it when your task finishes.'
        : 'Add your Vast.ai key any time in Settings → Vast.ai.'}
      {' '}New versions arrive through the UPDATE button at the top; one click installs them.
    </StepTitle>
  );
}
