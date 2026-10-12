// Settings: GPU profiles editor (table with a form dialog, or raw JSON). Owner: ui-views.
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { CatalogModel, GpuProfile } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button, IconButton } from '@renderer/components/ui/button';
import { ConfirmDialog, Dialog, DialogContent } from '@renderer/components/ui/dialog';
import { Field, Input } from '@renderer/components/ui/input';
import { Select } from '@renderer/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { Switch } from '@renderer/components/ui/toggles';
import { formatMoney } from '@renderer/lib/format';
import { loadGpuCatalog } from '@renderer/state/actions';
import { useGpu } from '@renderer/state/gpu';
import { useSettings } from '@renderer/state/settings';
import { gpuSpec, profileVramGb, splitModelLabel } from '../../gpu/model';
import { Group, JsonEditor, patchVast } from '../components';
import { validateProfiles } from '../validate';

export function ProfilesEditor() {
  const profiles = useSettings((s) => s.settings?.vast.profiles ?? []);
  const catalog = useGpu((s) => s.catalog);
  const [tab, setTab] = useState('table');
  const [editing, setEditing] = useState<GpuProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<GpuProfile | null>(null);

  useEffect(() => {
    void loadGpuCatalog(false, true);
  }, []);

  const modelName = (id: string) => {
    const m = catalog?.find((c) => c.id === id);
    return m ? splitModelLabel(m.label).name : id;
  };

  return (
    <Group
      title="GPU profiles"
      testId="settings-vast-profiles"
      description="The hardware choices on the GPU page. Each profile says which Vast GPUs qualify, the minimum specs, a hard price cap per hour and its default model."
      flush
      actions={
        <Button
          size="sm"
          variant="secondary"
          icon={Plus}
          data-testid="profile-add"
          onClick={() => {
            setEditing(null);
            setOpen(true);
            setTab('table');
          }}
        >
          Add profile
        </Button>
      }
    >
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="px-4" aria-label="Profiles editor view">
          <TabsTrigger value="table" data-testid="profiles-tab-table">
            Table
          </TabsTrigger>
          <TabsTrigger value="json" data-testid="profiles-tab-json">
            JSON
          </TabsTrigger>
        </TabsList>
        <TabsContent value="table">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-ui" data-testid="profiles-table">
              <thead>
                <tr className="border-b border-ob-border text-left">
                  {['Profile', 'GPUs', 'Price cap', 'Default model', ''].map((h, i) => (
                    <th key={i} className="ob-section-label px-4 py-2 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.id} className="ob-transition border-b border-ob-border last:border-b-0 hover:bg-ob-hover" data-testid="profile-row" data-id={p.id}>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-col">
                        <span className="font-medium text-ob-text">{p.label}</span>
                        <span className="font-mono text-[11px] text-ob-text-3">{p.id}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-ob-text-2">
                      {gpuSpec(p)} <span className="text-ob-text-3">· {profileVramGb(p)} GB</span>
                      {p.datacenterOnly ? (
                        <Badge tone="accent" className="ml-2">
                          datacenter
                        </Badge>
                      ) : null}
                    </td>
                    <td className="ob-tabular px-4 py-2.5 font-mono text-[12px] text-ob-text-2">{formatMoney(p.maxPricePerHour)}/h</td>
                    <td className="max-w-[240px] truncate px-4 py-2.5 text-ob-text-2" title={p.defaultModelId}>
                      {modelName(p.defaultModelId)}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-0.5">
                        <IconButton
                          label={`Edit ${p.label}`}
                          icon={Pencil}
                          size="lg"
                          data-testid="profile-edit"
                          onClick={() => {
                            setEditing(p);
                            setOpen(true);
                          }}
                        />
                        <IconButton label={`Delete ${p.label}`} icon={Trash2} size="lg" variant="danger" disabled={profiles.length <= 1} data-testid="profile-delete" onClick={() => setDeleting(p)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
        <TabsContent value="json">
          <div className="p-4">
            <ProfilesJson profiles={profiles} />
          </div>
        </TabsContent>
      </Tabs>

      <ProfileDialog open={open} onOpenChange={setOpen} profile={editing} catalog={catalog} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        danger
        title="Delete this profile?"
        description={deleting ? `"${deleting.label}" disappears from the GPU page. Past sessions keep their history.` : undefined}
        confirmLabel="Delete profile"
        onConfirm={async () => {
          if (deleting) await patchVast({ profiles: profiles.filter((p) => p.id !== deleting.id) }, 'Profile deleted');
        }}
      />
    </Group>
  );
}

function ProfilesJson({ profiles }: { profiles: GpuProfile[] }) {
  return (
    <JsonEditor<GpuProfile[]>
      testId="profiles-json"
      value={profiles}
      minRows={12}
      validate={(v) => validateProfiles(v).errors}
      onApply={async (v) => {
        const r = validateProfiles(v);
        return r.profiles ? patchVast({ profiles: r.profiles }, 'Profiles saved') : false;
      }}
      hint="An array of profiles. The price cap (maxPricePerHour) is enforced when searching offers."
    />
  );
}

// ───────────────────────────── Profile dialog ─────────────────────────────

interface Draft {
  id: string;
  label: string;
  description: string;
  gpuNames: string;
  numGpus: string;
  minGpuRamGb: string;
  minCpuRamGb: string;
  minDiskGb: string;
  minInetDownMbps: string;
  minReliability: string;
  maxPricePerHour: string;
  datacenterOnly: boolean;
  defaultModelId: string;
}

const toDraft = (p: GpuProfile | null, defaultModelId: string): Draft =>
  p
    ? {
        id: p.id,
        label: p.label,
        description: p.description,
        gpuNames: p.gpuNames.join(', '),
        numGpus: String(p.numGpus),
        minGpuRamGb: String(p.minGpuRamGb),
        minCpuRamGb: String(p.minCpuRamGb),
        minDiskGb: String(p.minDiskGb),
        minInetDownMbps: String(p.minInetDownMbps),
        minReliability: String(p.minReliability),
        maxPricePerHour: String(p.maxPricePerHour),
        datacenterOnly: p.datacenterOnly,
        defaultModelId: p.defaultModelId,
      }
    : { id: '', label: '', description: '', gpuNames: 'RTX 5090', numGpus: '1', minGpuRamGb: '30', minCpuRamGb: '32', minDiskGb: '80', minInetDownMbps: '500', minReliability: '0.98', maxPricePerHour: '1', datacenterOnly: false, defaultModelId };

function draftToCandidate(d: Draft): unknown {
  return {
    id: d.id.trim(),
    label: d.label,
    description: d.description,
    gpuNames: d.gpuNames.split(',').map((s) => s.trim()).filter(Boolean),
    numGpus: Number(d.numGpus),
    minGpuRamGb: Number(d.minGpuRamGb),
    minCpuRamGb: Number(d.minCpuRamGb),
    minDiskGb: Number(d.minDiskGb),
    minInetDownMbps: Number(d.minInetDownMbps),
    minReliability: Number(d.minReliability),
    maxPricePerHour: Number(d.maxPricePerHour),
    datacenterOnly: d.datacenterOnly,
    defaultModelId: d.defaultModelId,
  };
}

function ProfileDialog({ open, onOpenChange, profile, catalog }: { open: boolean; onOpenChange: (o: boolean) => void; profile: GpuProfile | null; catalog: CatalogModel[] | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <ProfileForm key={profile?.id ?? 'new'} profile={profile} catalog={catalog} onClose={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function ProfileForm({ profile, catalog, onClose }: { profile: GpuProfile | null; catalog: CatalogModel[] | null; onClose: () => void }) {
  const editing = !!profile;
  const profiles = useSettings((s) => s.settings?.vast.profiles ?? []);
  const [d, setD] = useState<Draft>(() => toDraft(profile, catalog?.[0]?.id ?? ''));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const problems = useMemo(() => {
    const others = profiles.filter((p) => p.id !== profile?.id);
    const r = validateProfiles([draftToCandidate(d)]);
    const errs = r.errors.map((e) => e.replace(/^profiles\[0\]\./, '').replace(/^profiles\[0\]: /, ''));
    if (others.some((p) => p.id === d.id.trim())) errs.push(`id: "${d.id.trim()}" is already used by another profile`);
    return errs;
  }, [d, profiles, profile?.id]);

  const modelOptions = useMemo(() => {
    const list = catalog ?? [];
    const opts = list.map((m) => ({ value: m.id, label: splitModelLabel(m.label).name, description: `${m.variant} · ${m.sizeGb.toFixed(0)} GB${m.experimental ? ' · experimental' : ''}` }));
    if (d.defaultModelId && !list.some((m) => m.id === d.defaultModelId)) opts.unshift({ value: d.defaultModelId, label: d.defaultModelId, description: 'not in the catalog' });
    return opts;
  }, [catalog, d.defaultModelId]);

  const save = async () => {
    setSubmitted(true);
    if (problems.length) return;
    const r = validateProfiles([draftToCandidate(d)]);
    if (!r.profiles) return;
    const next = r.profiles[0];
    setSaving(true);
    const ok = await patchVast({ profiles: editing ? profiles.map((p) => (p.id === profile?.id ? next : p)) : [...profiles, next] }, editing ? 'Profile saved' : 'Profile added');
    setSaving(false);
    if (ok) onClose();
  };

  const num = (k: keyof Draft, label: string, unit?: string, step = '1') => (
    <Field label={label} htmlFor={`pf-${k}`}>
      <div className="flex items-center gap-2">
        <Input id={`pf-${k}`} data-testid={`profile-${k}`} inputMode="decimal" mono step={step} value={d[k] as string} className="w-full" onChange={(e) => set(k, e.target.value as never)} />
        {unit ? <span className="w-10 shrink-0 text-small text-ob-text-3">{unit}</span> : null}
      </div>
    </Field>
  );

  return (
    <DialogContent
      size="lg"
      title={editing ? `Edit ${profile?.label}` : 'Add a GPU profile'}
      description="Vast.ai GPU names use spaces, e.g. RTX 5090 or RTX PRO 6000 WS."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} data-testid="profile-save" onClick={() => void save()}>
            {editing ? 'Save changes' : 'Add profile'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        data-testid="profile-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="Id" htmlFor="pf-id" description={editing ? 'The id cannot change.' : 'Lowercase letters, digits, - and _'}>
            <Input id="pf-id" data-testid="profile-id" mono disabled={editing} value={d.id} placeholder="budget" onChange={(e) => set('id', e.target.value)} />
          </Field>
          <Field label="Name" htmlFor="pf-label">
            <Input id="pf-label" data-testid="profile-label" value={d.label} placeholder="Budget" onChange={(e) => set('label', e.target.value)} />
          </Field>
        </div>
        <Field label="Description" htmlFor="pf-desc">
          <Input id="pf-desc" data-testid="profile-description" value={d.description} placeholder="1× RTX 4090 — a cheap way to run a 14B model" onChange={(e) => set('description', e.target.value)} />
        </Field>
        <Field label="GPU names" htmlFor="pf-gpus" description="Comma-separated Vast gpu_name values this profile accepts.">
          <Input id="pf-gpus" data-testid="profile-gpuNames" mono value={d.gpuNames} placeholder="RTX 5090" spellCheck={false} onChange={(e) => set('gpuNames', e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-4">
          {num('numGpus', 'GPUs')}
          {num('minGpuRamGb', 'VRAM per GPU', 'GB')}
          {num('minCpuRamGb', 'System RAM', 'GB')}
          {num('minDiskGb', 'Disk', 'GB')}
          {num('minInetDownMbps', 'Download speed', 'Mbps')}
          {num('minReliability', 'Reliability (0–1)', undefined, '0.01')}
        </div>
        <div className="grid grid-cols-2 items-end gap-4">
          {num('maxPricePerHour', 'Price cap', '$/h', '0.05')}
          <Field label="Datacenter machines only" inline htmlFor="pf-dc">
            <Switch id="pf-dc" aria-label="Datacenter machines only" checked={d.datacenterOnly} onCheckedChange={(v) => set('datacenterOnly', v)} />
          </Field>
        </div>
        <Field label="Default model" htmlFor="pf-model">
          {modelOptions.length ? (
            <Select id="pf-model" aria-label="Default model" value={d.defaultModelId} onValueChange={(v) => set('defaultModelId', v)} options={modelOptions} placeholder="Choose a model" />
          ) : (
            <Input id="pf-model" data-testid="profile-defaultModelId" mono value={d.defaultModelId} placeholder="catalog model id" onChange={(e) => set('defaultModelId', e.target.value)} />
          )}
        </Field>
        {submitted && problems.length ? (
          <ul role="alert" data-testid="profile-errors" className="flex flex-col gap-1 rounded-ctl border border-[rgba(240,113,120,0.3)] bg-ob-danger-soft px-3 py-2 text-small text-ob-text">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        ) : null}
      </form>
    </DialogContent>
  );
}
