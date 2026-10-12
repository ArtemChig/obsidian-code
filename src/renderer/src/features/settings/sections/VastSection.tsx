// Settings: Vast.ai (API key, budget & safety nets, server, profiles). Owner: ui-views.
import { ArrowUpRight, CircleAlert, CircleCheck, FlaskConical } from 'lucide-react';
import { useState } from 'react';
import type { RpcResult } from '@shared/protocol';
import { Button } from '@renderer/components/ui/button';
import { Spinner } from '@renderer/components/ui/feedback';
import { Switch } from '@renderer/components/ui/toggles';
import { openExternal } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { formatMoney } from '@renderer/lib/format';
import { errorMessage, rpc } from '@renderer/lib/rpc';
import { gpuHoldsInstance, useGpu } from '@renderer/state/gpu';
import { useSettings } from '@renderer/state/settings';
import { Group, NumberField, Row, SecretField, Section, TextField, patchVast } from '../components';
import { joinArgs, splitArgs } from '../validate';
import { ProfilesEditor } from './ProfilesEditor';

// Verified 2026-10-12: docs.vast.ai/api-reference/introduction links API-key creation to this page.
const VAST_KEYS_URL = 'https://cloud.vast.ai/manage-keys/';

export function VastSection() {
  const settings = useSettings((s) => s.settings);
  if (!settings) return null;
  return (
    <Section id="vast" title="Vast.ai" description="Rent a GPU by the hour for bigger models. Every limit below also runs on the rented machine itself, so it destroys itself even if this app crashes.">
      <ApiKey />
      <BudgetAndSafety />
      <Server />
      <ProfilesEditor />
    </Section>
  );
}

// ───────────────────────────── API key ─────────────────────────────

type KeyTest = RpcResult<'gpu.testKey'>;

function ApiKey() {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<KeyTest | null>(null);
  const hasKey = useGpu((s) => s.hasApiKey);
  // While an instance exists only this key can destroy it: no removal, and a replacement must be the same account.
  const holding = useGpu((s) => gpuHoldsInstance(s.status));

  const test = async () => {
    setTesting(true);
    try {
      const r = await rpc.request('gpu.testKey', {});
      setResult(r);
      if (r.creditBalance != null) useGpu.setState((s) => (s.status ? { status: { ...s.status, creditBalance: r.creditBalance } } : s));
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Group title="API key" testId="settings-vast-key">
      <Row
        stacked
        label="Vast.ai API key"
        description={
          <>
            Create a key at{' '}
            <button type="button" className="inline-flex items-center gap-0.5 text-t1 underline decoration-line underline-offset-2 hover:decoration-acc" onClick={() => openExternal(VAST_KEYS_URL)}>
              cloud.vast.ai <ArrowUpRight size={11} aria-hidden />
            </button>{' '}
            with permissions: instance read and write, user read and write (to register the app&rsquo;s SSH key), and misc (offer search). The key is encrypted on this PC and never shown again.
          </>
        }
      >
        <SecretField
          name="vast.apiKey"
          testId="secret-vast"
          placeholder="Paste your Vast.ai API key…"
          removeBlocked={holding ? 'A GPU instance is rented or parked. Clock out (and destroy the parked instance) first; without the key the app cannot stop the billing.' : undefined}
          replaceWarning={
            holding
              ? 'A GPU instance is rented or parked. The new key must belong to the same Vast.ai account, otherwise the app can no longer clock out and the instance keeps billing until its server-side watchdog stops it.'
              : undefined
          }
          onChanged={(present) => {
            setResult(null);
            if (present) void test();
          }}
          extra={
            <Button variant="secondary" icon={FlaskConical} loading={testing} disabled={hasKey === false} data-testid="vast-test-key" onClick={() => void test()}>
              Test key
            </Button>
          }
        />
        {testing && !result ? (
          <div className="mt-2 flex items-center gap-2 font-mono text-[9.5px] text-t3">
            <Spinner size={12} /> Checking with Vast.ai…
          </div>
        ) : null}
        {result ? (
          <div
            role="status"
            data-testid="vast-test-result"
            data-ok={result.ok}
            className={cn('mt-2 flex items-start gap-[9px] rounded-[2px] px-3 py-[9px] text-[11.5px] text-t2', result.ok ? 'shadow-[inset_0_0_0_1px_var(--ok-edge)]' : 'shadow-[inset_0_0_0_1px_var(--err)]')}
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
      </Row>
    </Group>
  );
}

// ───────────────────────────── Budget & safety ─────────────────────────────

function BudgetAndSafety() {
  const v = useSettings((s) => s.settings?.vast);
  if (!v) return null;
  return (
    <Group title="Budget & safety nets" testId="settings-vast-safety">
      <Row label="Monthly budget" htmlFor="vast-budget" description="Clock-in is blocked once this month's spend reaches it, and a running GPU is clocked out automatically.">
        <NumberField id="vast-budget" testId="vast-budget" value={v.monthlyBudget} min={1} max={100000} prefix="$" unit="/mo" onCommit={(n) => patchVast({ monthlyBudget: n }, 'Budget saved')} />
      </Row>
      <Row label="Idle timeout" htmlFor="vast-idle" description="Enforced by a watchdog on the rented machine: it destroys itself after this many minutes without a request to the model.">
        <NumberField id="vast-idle" testId="vast-idle" value={v.idleMinutes} min={1} max={1440} integer unit="min" onCommit={(n) => patchVast({ idleMinutes: n })} />
      </Row>
      <Row label="App heartbeat" htmlFor="vast-heartbeat" description="While clocked in, this app pings the server every 60 s. The server-side watchdog destroys the instance when no ping has arrived for this many minutes (app closed, crash, sleep, lost network).">
        <NumberField id="vast-heartbeat" testId="vast-heartbeat" value={v.heartbeatMinutes} min={1} max={240} integer unit="min" onCommit={(n) => patchVast({ heartbeatMinutes: n })} />
      </Row>
      <Row label="Maximum session length" htmlFor="vast-maxhours" description="Hard cap per clock-in, however busy the GPU is.">
        <NumberField id="vast-maxhours" testId="vast-maxhours" value={v.maxSessionHours} min={0.5} max={72} unit="hours" onCommit={(n) => patchVast({ maxSessionHours: n })} />
      </Row>
      <Row
        label="Clock out when the app quits"
        description={
          v.clockOutOnQuit
            ? 'On: quitting Obsidian Code destroys the instance (waits up to 20 s). Turn off only if you want the GPU to outlive the app.'
            : `Off: the GPU keeps running and billing after you quit, until the server-side watchdog destroys it — up to ${v.heartbeatMinutes} min (the heartbeat timeout), sooner if the ${v.idleMinutes}-min idle timeout is reached first.`
        }
        testId="vast-quit-row"
      >
        <Switch aria-label="Clock out when the app quits" checked={v.clockOutOnQuit} onCheckedChange={(c) => void patchVast({ clockOutOnQuit: c })} />
      </Row>
      <Row stacked label="When clocking out" description="Destroying is free after it ends but the model downloads again next time. Parking keeps the disk (billed as storage) so the next clock-in on the same machine starts fast.">
        <div className="flex flex-wrap items-center gap-4">
          <div role="radiogroup" aria-label="Clock-out mode" className="inline-flex h-7 items-stretch overflow-hidden rounded-[2px] shadow-[inset_0_0_0_1px_var(--line)]" data-testid="vast-clockout-mode">
            {(['destroy', 'park'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={v.clockOutMode === m}
                data-testid={`vast-mode-${m}`}
                onClick={() => v.clockOutMode !== m && void patchVast({ clockOutMode: m })}
                className={cn('ob-transition flex h-full items-center px-[11px] text-[11px] capitalize tracking-[-0.008em] outline-offset-[-2px]', v.clockOutMode === m ? 'bg-acc font-semibold text-acc-ink' : 'text-t3 hover:text-t1', m === 'park' && v.clockOutMode !== m && 'shadow-[inset_1px_0_0_var(--line)]')}
              >
                {m === 'destroy' ? 'Destroy' : 'Park'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-[11.5px]">
            <label htmlFor="vast-parkdays" className={v.clockOutMode === 'park' ? 'text-t2' : 'text-t3'}>
              Destroy parked instances after
            </label>
            <NumberField id="vast-parkdays" testId="vast-parkdays" value={v.parkMaxDays} min={1} max={30} integer unit="days" width="w-[64px]" disabled={v.clockOutMode !== 'park'} onCommit={(n) => patchVast({ parkMaxDays: n })} />
          </div>
        </div>
      </Row>
    </Group>
  );
}

// ───────────────────────────── Server ─────────────────────────────

function Server() {
  const v = useSettings((s) => s.settings?.vast);
  if (!v) return null;
  return (
    <Group title="Server" testId="settings-vast-server">
      <Row stacked label="Docker image" htmlFor="vast-image" description="The llama.cpp CUDA image the rented machine runs. Pin a tag (never :latest) with CUDA 12.8 or newer for RTX 5090 and RTX PRO 6000.">
        <TextField id="vast-image" testId="vast-image" mono value={v.image} validate={(x) => (x.trim() && !/\s/.test(x.trim()) ? null : 'Enter an image reference without spaces')} onCommit={(x) => patchVast({ image: x })} />
      </Row>
      <Row label="Local tunnel port" htmlFor="vast-port" description="The rented server is forwarded to this port on 127.0.0.1.">
        <NumberField id="vast-port" testId="vast-port" value={v.localPort} min={1024} max={65535} integer onCommit={(n) => patchVast({ localPort: n })} width="w-[88px]" />
      </Row>
      <Row stacked label="Extra llama-server arguments" htmlFor="vast-args" description="Appended to every launch, e.g. --parallel 2 --no-warmup. Use quotes around values with spaces.">
        <TextField id="vast-args" testId="vast-args" mono value={joinArgs(v.extraLlamaArgs)} placeholder="(none)" onCommit={(x) => patchVast({ extraLlamaArgs: splitArgs(x) })} />
      </Row>
    </Group>
  );
}
