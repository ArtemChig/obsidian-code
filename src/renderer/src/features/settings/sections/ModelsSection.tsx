// Settings: Models & providers (local server, custom endpoints, defaults). Owner: ui-views.
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CustomEndpoint, ModelRef, ProviderInfo } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button, IconButton } from '@renderer/components/ui/button';
import { ConfirmDialog, Dialog, DialogContent } from '@renderer/components/ui/dialog';
import { StatusDot } from '@renderer/components/ui/feedback';
import { Field, Input, Textarea } from '@renderer/components/ui/input';
import { Select, type SelectGroupDef } from '@renderer/components/ui/select';
import { Switch } from '@renderer/components/ui/toggles';
import { modelKey, parseModelKey, pluralize } from '@renderer/lib/format';
import { refreshModels, setSecret } from '@renderer/state/actions';
import { useModels } from '@renderer/state/models';
import { useModelGroups } from '@renderer/state/selectors';
import { useSettings } from '@renderer/state/settings';
import { Group, Row, Section, SecretField, SecretPresence, TextField, patchLocal, saveSettings, useSecretPresence } from '../components';
import { parseModelList, slugify, validateUrl } from '../validate';

export function ModelsSection() {
  const settings = useSettings((s) => s.settings);
  if (!settings) return null;
  return (
    <Section id="models" title="Models & providers" description="Where the agent gets its models: the llama-server on this PC, any OpenAI-compatible endpoint, or the Vast.ai GPU (configured separately).">
      <LocalServer />
      <CustomEndpoints />
      <Defaults />
    </Section>
  );
}

// ───────────────────────────── Local server ─────────────────────────────

function ProviderStatus({ provider, modelCount }: { provider?: ProviderInfo; modelCount: number }) {
  if (!provider) return <span className="text-small text-ob-text-3">Not tested yet.</span>;
  const tone = provider.status === 'online' ? 'success' : provider.status === 'error' ? 'danger' : provider.status === 'starting' ? 'warning' : 'neutral';
  return (
    <div className="flex min-w-0 items-center gap-2 text-small" data-testid="provider-status" data-status={provider.status}>
      <StatusDot tone={tone} size={7} glow={provider.status === 'online'} />
      <span className="font-medium capitalize text-ob-text-2">{provider.status}</span>
      {provider.detail ? <span className="min-w-0 truncate text-ob-text-3">· {provider.detail}</span> : null}
      {provider.status === 'online' ? <span className="shrink-0 text-ob-text-3">· {pluralize(modelCount, 'model')}</span> : null}
    </div>
  );
}

function LocalServer() {
  const local = useSettings((s) => s.settings?.local);
  const providers = useModels((s) => s.providers);
  const models = useModels((s) => s.models);
  const refreshing = useModels((s) => s.refreshing);
  const provider = providers.find((p) => p.id === 'local');
  const count = models.filter((m) => m.ref.provider === 'local').length;
  if (!local) return null;
  return (
    <Group title="Local server" testId="settings-local" description="A llama-server (or any OpenAI-compatible server) running on this PC.">
      <Row label="Use the local server" description="Offer its models in the model picker.">
        <Switch aria-label="Use the local server" checked={local.enabled} onCheckedChange={(v) => void patchLocal({ enabled: v })} />
      </Row>
      <Row stacked label="Base URL" htmlFor="local-url" description="Where it listens, e.g. http://127.0.0.1:8080. Saved when you leave the field.">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-start gap-2">
            <TextField
              id="local-url"
              testId="local-url"
              mono
              flowError
              value={local.baseUrl}
              validate={(v) => validateUrl(v)}
              onCommit={async (v) => {
                if (await patchLocal({ baseUrl: v })) void refreshModels();
              }}
            />
            <Button variant="secondary" icon={RefreshCw} loading={refreshing} data-testid="local-test" onClick={() => void refreshModels()}>
              Test
            </Button>
          </div>
          <ProviderStatus provider={provider} modelCount={count} />
        </div>
      </Row>
      <Row stacked label="API key (optional)" description="Only needed if the server was started with --api-key.">
        <SecretField name="local.apiKey" testId="secret-local" placeholder="Paste the server's API key…" />
      </Row>
    </Group>
  );
}

// ───────────────────────────── Custom endpoints ─────────────────────────────

function CustomEndpoints() {
  const custom = useSettings((s) => s.settings?.custom ?? []);
  const providers = useModels((s) => s.providers);
  const secrets = useSecretPresence(custom.map((c) => c.apiKeySecret ?? `custom.${c.id}.apiKey`));
  const [editing, setEditing] = useState<CustomEndpoint | null>(null);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<CustomEndpoint | null>(null);

  return (
    <Group
      title="Custom endpoints"
      testId="settings-custom"
      description="OpenAI-compatible APIs (OpenRouter, vLLM, LM Studio, a remote llama-server…)."
      actions={
        <Button
          size="sm"
          variant="secondary"
          icon={Plus}
          data-testid="endpoint-add"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          Add endpoint
        </Button>
      }
    >
      {custom.length === 0 ? (
        <div className="px-4 py-5 text-ui text-ob-text-3" data-testid="endpoint-empty">
          No custom endpoints yet.
        </div>
      ) : (
        custom.map((c) => {
          const p = providers.find((x) => x.id === `custom:${c.id}`);
          const hasKey = secrets[c.apiKeySecret ?? `custom.${c.id}.apiKey`];
          return (
            <div key={c.id} className="flex items-center gap-3 px-4 py-3" data-testid="endpoint-row" data-id={c.id}>
              <StatusDot tone={p?.status === 'online' ? 'success' : p?.status === 'error' ? 'danger' : 'neutral'} size={7} glow={p?.status === 'online'} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-ui font-medium text-ob-text">{c.label}</span>
                  <SecretPresence present={hasKey} />
                  {c.models?.length ? <Badge tone="neutral">{pluralize(c.models.length, 'model')}</Badge> : null}
                </div>
                <span className="truncate font-mono text-[11.5px] text-ob-text-3" title={c.baseUrl}>
                  {c.baseUrl}
                  {p?.detail ? ` · ${p.detail}` : ''}
                </span>
              </div>
              <IconButton
                label={`Edit ${c.label}`}
                icon={Pencil}
                size="lg"
                data-testid="endpoint-edit"
                onClick={() => {
                  setEditing(c);
                  setOpen(true);
                }}
              />
              <IconButton label={`Delete ${c.label}`} icon={Trash2} size="lg" variant="danger" data-testid="endpoint-delete" onClick={() => setDeleting(c)} />
            </div>
          );
        })
      )}
      <EndpointDialog open={open} onOpenChange={setOpen} endpoint={editing} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        danger
        title="Remove this endpoint?"
        description={deleting ? `"${deleting.label}" and its stored API key are deleted. Sessions that use its models keep their history.` : undefined}
        confirmLabel="Remove endpoint"
        onConfirm={async () => {
          if (!deleting) return;
          const list = useSettings.getState().settings?.custom ?? [];
          if (await saveSettings({ custom: list.filter((c) => c.id !== deleting.id) }, 'Endpoint removed')) {
            await setSecret(deleting.apiKeySecret ?? `custom.${deleting.id}.apiKey`, null);
            void refreshModels();
          }
        }}
      />
    </Group>
  );
}

function EndpointDialog({ open, onOpenChange, endpoint }: { open: boolean; onOpenChange: (o: boolean) => void; endpoint: CustomEndpoint | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <EndpointForm key={endpoint?.id ?? 'new'} endpoint={endpoint} onClose={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function EndpointForm({ endpoint, onClose }: { endpoint: CustomEndpoint | null; onClose: () => void }) {
  const editing = !!endpoint;
  const [label, setLabel] = useState(endpoint?.label ?? '');
  const [url, setUrl] = useState(endpoint?.baseUrl ?? '');
  const [key, setKey] = useState('');
  const [modelsText, setModelsText] = useState((endpoint?.models ?? []).join('\n'));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const existingKey = useSecretPresence(endpoint ? [endpoint.apiKeySecret ?? `custom.${endpoint.id}.apiKey`] : [])[endpoint?.apiKeySecret ?? `custom.${endpoint?.id}.apiKey`];

  const errors = {
    label: label.trim() ? null : 'Give the endpoint a name',
    url: validateUrl(url),
  };
  const show = (k: keyof typeof errors) => (submitted ? errors[k] : null);

  const save = async () => {
    setSubmitted(true);
    if (errors.label || errors.url) return;
    setSaving(true);
    const list = useSettings.getState().settings?.custom ?? [];
    const id = endpoint?.id ?? slugify(label, list.map((c) => c.id));
    const secretName = endpoint?.apiKeySecret ?? `custom.${id}.apiKey`;
    const models = parseModelList(modelsText);
    const next: CustomEndpoint = {
      id,
      label: label.trim(),
      baseUrl: url.trim().replace(/\/+$/, ''),
      ...(key.trim() || existingKey ? { apiKeySecret: secretName } : {}),
      ...(models.length ? { models } : {}),
    };
    let ok = true;
    if (key.trim()) ok = await setSecret(secretName, key.trim());
    if (ok) ok = await saveSettings({ custom: editing ? list.map((c) => (c.id === id ? next : c)) : [...list, next] }, editing ? 'Endpoint saved' : 'Endpoint added');
    setSaving(false);
    if (ok) {
      onClose();
      void refreshModels();
    }
  };

  return (
    <DialogContent
      title={editing ? 'Edit endpoint' : 'Add an endpoint'}
      description="Any server that speaks the OpenAI chat-completions API."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} data-testid="endpoint-save" onClick={() => void save()}>
            {editing ? 'Save changes' : 'Add endpoint'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        data-testid="endpoint-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" htmlFor="ep-label" error={show('label') ?? undefined}>
          <Input id="ep-label" data-testid="endpoint-label" value={label} invalid={!!show('label')} placeholder="OpenRouter" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Base URL" htmlFor="ep-url" error={show('url') ?? undefined} description="Up to and including /v1, e.g. https://openrouter.ai/api/v1">
          <Input id="ep-url" data-testid="endpoint-url" mono value={url} invalid={!!show('url')} placeholder="https://openrouter.ai/api/v1" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label="API key" htmlFor="ep-key" description={editing && existingKey ? 'A key is stored. Leave empty to keep it, or paste a new one to replace it.' : 'Optional. Stored encrypted, never shown again.'}>
          <Input id="ep-key" data-testid="endpoint-key" type="password" autoComplete="new-password" mono value={key} placeholder={editing && existingKey ? '•••••••• (saved)' : 'sk-…'} spellCheck={false} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field label="Models" htmlFor="ep-models" description="Optional: one model id per line (or comma-separated). Leave empty to list them from the server.">
          <Textarea id="ep-models" data-testid="endpoint-models" mono minRows={3} maxRows={8} value={modelsText} placeholder={'qwen/qwen3.8-235b-a22b\nmeta-llama/llama-4-maverick'} onChange={(e) => setModelsText(e.target.value)} />
        </Field>
      </form>
    </DialogContent>
  );
}

// ───────────────────────────── Defaults ─────────────────────────────

function Defaults() {
  const settings = useSettings((s) => s.settings);
  const groups = useModelGroups();
  const selectGroups = useMemo<SelectGroupDef[]>(() => {
    const out: SelectGroupDef[] = [{ label: 'Automatic', options: [{ value: 'auto', label: 'Best available', description: 'Vast GPU if ready, else local, else custom' }] }];
    const seen = new Set<string>();
    for (const g of groups) {
      const options = g.models.map((m) => {
        seen.add(modelKey(m.ref));
        return { value: modelKey(m.ref), label: m.label, description: m.variant ?? undefined };
      });
      if (options.length) out.push({ label: g.provider.label, options });
    }
    const cur = settings?.defaultModel;
    if (cur && !seen.has(modelKey(cur))) out.push({ label: 'Saved', options: [{ value: modelKey(cur), label: cur.model, description: `${cur.provider} (not currently listed)` }] });
    return out;
  }, [groups, settings?.defaultModel]);
  if (!settings) return null;
  const value = settings.defaultModel ? modelKey(settings.defaultModel) : 'auto';
  return (
    <Group title="Defaults" testId="settings-defaults">
      <Row label="Default model" htmlFor="default-model" description="Used by new sessions and by scheduled tasks that do not name a model.">
        <Select
          id="default-model"
          aria-label="Default model"
          value={value}
          className="w-[300px]"
          align="end"
          groups={selectGroups}
          onValueChange={(v) => {
            const ref: ModelRef | null = v === 'auto' ? null : parseModelKey(v);
            void saveSettings({ defaultModel: ref }, 'Default model saved');
          }}
        />
      </Row>
      <Row label="Prefer uncensored models" description="When a default has to be picked automatically (GPU clock-in, model fallbacks), choose the uncensored build over the standard one.">
        <Switch aria-label="Prefer uncensored models" checked={settings.preferUncensored} onCheckedChange={(v) => void saveSettings({ preferUncensored: v })} />
      </Row>
      <Row label="Think by default" description="Turn on the model's reasoning for new sessions. You can still toggle it per session.">
        <Switch aria-label="Think by default" checked={settings.thinkingByDefault} onCheckedChange={(v) => void saveSettings({ thinkingByDefault: v })} />
      </Row>
    </Group>
  );
}
