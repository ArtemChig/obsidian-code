// UI kit gallery for design review: open http://localhost:5173/?demo=1&gallery=1. Owner: ui-foundation.
// Every primitive in the M13 "Obsidian" language: one #000 ground, hairlines for structure, borders on actionables only.
import { Bell, Download, FileText, FolderOpen, Grid2x2, List, Pencil, Play, Plus, Search, Settings, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  AppMark,
  Badge,
  Button,
  Card,
  Checkbox,
  CodeBlock,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  LiveDuration,
  Markdown,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProgressBar,
  RelativeTime,
  SectionLabel,
  Segmented,
  Select,
  Shortcut,
  Skeleton,
  Spinner,
  StatusDot,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Tooltip,
  toast,
  type Tone,
} from '@renderer/components/ui';
import { cn } from '@renderer/lib/cn';

const TONES: Tone[] = ['neutral', 'accent', 'success', 'warning', 'danger', 'violet'];

const SWATCHES: [string, string, string][] = [
  ['Ground', '--s0', '000000'],
  ['Well', '--s1', '07070A'],
  ['Raised', '--s2', '0E0E12'],
  ['Control', '--s3', '17171C'],
  ['Track', '--s4', '23232A'],
  ['Line 3.5:1', '--line', '63636E'],
  ['Text 3', '--t3', '7A7A85'],
  ['Text 2', '--t2', 'ADADB6'],
  ['Ink 21:1', '--t1', 'FFFFFF'],
  ['Accent', '--acc', 'E6EEFF'],
  ['Rec', '--rec', 'FF453A'],
  ['Live', '--live', 'BF6BFF'],
  ['Error', '--err', 'FF6F62'],
  ['Warn', '--warn', 'FFD426'],
  ['Success', '--ok', '3BE07A'],
];

const SAMPLE_TS = `import { rpc } from '@renderer/lib/rpc';

/** Clock in with the default profile. */
export async function clockIn(profileId = 'light'): Promise<GpuStatus> {
  const status = await rpc.request('gpu.clockIn', { profileId });
  if (status.phase === 'error') throw new Error(status.lastError ?? 'failed');
  return status; // 42 · true · null
}`;

const SAMPLE_MD = `### Result

The reconnect loop now backs off with **jitter** and refetches state. See [the docs](https://docs.vast.ai) for details.

- Delay grows \`400ms → 10s\`
- Queued requests are re-sent
  - nested item

| Attempt | Delay |
|---:|---|
| 1 | 400 ms |
| 8 | 10 s |

> Note: per-second billing — clock out when you're done.

\`\`\`bash
npm test -- tests/unit/ui-foundation
\`\`\`
`;

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-4', className)}>
      <SectionLabel rule>{title}</SectionLabel>
      {children}
    </section>
  );
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

const ROWS = [
  { name: 'Fix GLM tool-call parsing', meta: 'obsidian-code / qwen3.8-27b', time: '2m', tone: 'violet' as Tone, on: true },
  { name: 'Hearth: stream TTS', meta: 'hearth / glm-4.7', time: '1h', tone: 'warning' as Tone, on: false },
  { name: 'Refactor billing loop', meta: 'vast-tools / 14 turns', time: '3d', tone: 'neutral' as Tone, on: false },
];

export function Gallery() {
  const [sw, setSw] = useState(true);
  const [sw2, setSw2] = useState(false);
  const [cb, setCb] = useState<boolean | 'indeterminate'>(true);
  const [sel, setSel] = useState('local');
  const [seg, setSeg] = useState('grid');
  const [quality, setQuality] = useState('high');
  const [confirm, setConfirm] = useState(false);
  const [checked, setChecked] = useState(true);
  const [text, setText] = useState('Auto-growing textarea.\nAdd lines to see it grow.');
  return (
    <div className="h-full overflow-y-auto bg-s0" data-testid="gallery">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-12 px-8 pb-16 pt-8">
        <header className="flex items-start justify-between gap-10 border-b border-rule pb-6">
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2 font-mono text-[9px] font-medium uppercase tracking-[0.22em] text-acc">
              <AppMark size={11} /> UI kit <span className="text-t3">/ M13 Obsidian</span>
            </div>
            <h1 className="text-[34px] font-semibold leading-[0.96] tracking-[-0.048em] text-t1">Obsidian</h1>
            <p className="max-w-[58ch] text-[12.5px] leading-[1.62] text-t2">
              Pure #000 with the chrome removed. No cards, no panel fills, no frames — content floats, held in place by space and a single hairline.
              Borders only on things you can act on; colour only for status.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-[7px] pt-1 font-mono text-[9px] tracking-[0.06em] text-t2">
            <span><span className="mr-2 text-t3 opacity-70">UI</span>Chivo</span>
            <span><span className="mr-2 text-t3 opacity-70">NUM</span>Chivo Mono</span>
            <span><span className="mr-2 text-t3 opacity-70">RADIUS</span>2px</span>
            <span><span className="mr-2 text-t3 opacity-70">ROW</span>28px</span>
            <Shortcut keys="Ctrl+K" />
          </div>
        </header>

        <div className="grid grid-cols-5 gap-x-2 gap-y-4 lg:grid-cols-[repeat(15,minmax(0,1fr))]">
          {SWATCHES.map(([name, v, hex]) => (
            <div key={v} className="flex min-w-0 flex-col">
              <i className="block h-[30px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]" style={{ background: `var(${v})` }} />
              <span className="mt-[7px] truncate font-mono text-[8px] uppercase tracking-[0.09em] text-t3">{name}</span>
              <b className="mt-0.5 font-mono text-[8.5px] font-medium text-t2">{hex}</b>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-x-12 gap-y-12">
          <Section title="Buttons">
            <Row>
              <Button variant="primary" icon={Plus}>
                Primary
              </Button>
              <Button variant="secondary" icon={FolderOpen}>
                Secondary
              </Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger" icon={Trash2}>
                Danger
              </Button>
              <Button variant="danger-solid">Delete</Button>
            </Row>
            <Row>
              <Button size="sm" variant="primary">
                Small 24
              </Button>
              <Button size="md">Medium 28</Button>
              <Button size="lg" variant="primary" icon={Play}>
                Large 32
              </Button>
              <Button loading variant="primary">
                Saving
              </Button>
              <Button disabled>Disabled</Button>
            </Row>
            <Row>
              <IconButton label="Search" icon={Search} shortcut="Ctrl+K" />
              <IconButton label="Settings" icon={Settings} variant="secondary" />
              <IconButton label="Edit" icon={Pencil} active />
              <IconButton label="Delete" icon={Trash2} variant="danger" />
              <IconButton label="Download" icon={Download} size="sm" />
              <IconButton label="Busy" icon={Bell} loading />
              <IconButton label="Play" icon={Play} variant="primary" />
            </Row>
          </Section>

          <Section title="Tags, status, keys">
            <Row>
              {TONES.map((t) => (
                <Badge key={t} tone={t} variant="outline">
                  {t}
                </Badge>
              ))}
            </Row>
            <Row>
              {TONES.map((t) => (
                <Badge key={t} tone={t} size="md">
                  {t}
                </Badge>
              ))}
            </Row>
            <Row className="gap-4">
              {TONES.map((t) => (
                <span key={t} className="flex items-center gap-[7px] font-mono text-[9px] uppercase tracking-[0.1em] text-t3">
                  <StatusDot tone={t} /> {t}
                </span>
              ))}
              <span className="flex items-center gap-[7px] font-mono text-[9px] uppercase tracking-[0.1em] text-t3">
                <StatusDot tone="violet" pulse glow /> live
              </span>
            </Row>
            <Row className="gap-3">
              <Kbd>Esc</Kbd>
              <Shortcut keys="Ctrl+Shift+P" />
              <Shortcut keys="Ctrl+K" plain />
              <Spinner />
              <Spinner size={16} className="text-live" />
              <RelativeTime ts={Date.now() - 3_600_000 * 5} className="font-mono text-[9.5px] text-t3" />
              <LiveDuration since={Date.now() - 125_000} className="font-mono text-[11px] text-t1" />
            </Row>
          </Section>

          <Section title="Inputs">
            <Field label="Session title" description="Shown in the sidebar">
              <Input placeholder="Untitled" />
            </Field>
            <Row>
              <Input icon={Search} placeholder="Search sessions, transcripts…" wrapperClassName="w-64" />
              <Input invalid defaultValue="bad value" className="w-36" />
              <Input mono defaultValue="http://127.0.0.1:8080" className="w-52" />
            </Row>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} minRows={2} maxRows={6} />
            <Row className="gap-4">
              <Select
                value={sel}
                onValueChange={setSel}
                className="w-56"
                mono
                aria-label="Provider"
                groups={[
                  { label: 'Local', options: [{ value: 'local', label: 'llama-server', description: '127.0.0.1:8080' }] },
                  { label: 'Cloud', options: [{ value: 'vast', label: 'Vast GPU' }, { value: 'or', label: 'OpenRouter', disabled: true }] },
                ]}
              />
              <Switch checked={sw} onCheckedChange={setSw} label="Thinking" />
              <Switch checked={sw2} onCheckedChange={setSw2} aria-label="Off switch" />
              <Checkbox checked={cb} onCheckedChange={setCb} label="Also restore files" />
              <Checkbox checked="indeterminate" onCheckedChange={() => {}} aria-label="Mixed" />
            </Row>
            <div className="border-t border-rule2">
              <Field inline label="Clock out on quit" description="Destroy the GPU instance when the app closes" className="border-b border-rule2 py-[9px]">
                <Switch checked={sw} onCheckedChange={setSw} aria-label="Clock out on quit" />
              </Field>
              <Field inline label="Quality" description="Higher settings cost disk, not CPU." className="border-b border-rule2 py-[9px]">
                <Segmented
                  value={quality}
                  onValueChange={setQuality}
                  aria-label="Quality"
                  options={[
                    { value: 'balanced', label: 'Balanced' },
                    { value: 'high', label: 'High' },
                    { value: 'lossless', label: 'Lossless' },
                  ]}
                />
              </Field>
            </div>
          </Section>

          <Section title="Tabs, segmented, progress">
            <Tabs defaultValue="changes">
              <TabsList>
                <TabsTrigger value="changes" count={3}>
                  Changes
                </TabsTrigger>
                <TabsTrigger value="todos">Todos</TabsTrigger>
                <TabsTrigger value="agents" count={1}>
                  Agents
                </TabsTrigger>
                <TabsTrigger value="files">Files</TabsTrigger>
              </TabsList>
              <TabsContent value="changes" className="py-3 text-[11.5px] text-t3">
                Underline tabs for panels: --t3 text, active --t1 with a 1 px --acc underline, mono counts.
              </TabsContent>
            </Tabs>
            <Row className="gap-4">
              <Tabs defaultValue="unc">
                <TabsList variant="pill">
                  <TabsTrigger value="unc">Uncensored</TabsTrigger>
                  <TabsTrigger value="std">Standard</TabsTrigger>
                </TabsList>
              </Tabs>
              <Segmented
                value={seg}
                onValueChange={setSeg}
                aria-label="Layout"
                options={[
                  { value: 'grid', label: 'Grid', icon: Grid2x2 },
                  { value: 'list', label: 'List', icon: List },
                ]}
              />
            </Row>
            <div className="flex flex-col gap-3">
              <ProgressBar value={0.42} />
              <ProgressBar value={0.85} tone="warning" size="md" />
              <ProgressBar value={null} tone="violet" />
              <div className="flex items-center gap-3">
                <span className="ob-cap shrink-0">Disk</span>
                <ProgressBar variant="segments" segments={20} value={0.4} tone="neutral" className="w-56" label="Disk used" />
                <ProgressBar variant="segments" segments={12} value={0.92} tone="warning" className="w-32" label="Budget used" />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="w-2/3" />
              <Skeleton className="w-1/3" />
            </div>
          </Section>

          <Section title="Rows & sections">
            <div className="border-t border-rule">
              <div className="flex h-7 items-center gap-3 border-b border-rule px-4">
                <span className="ob-label w-3" />
                <span className="ob-label flex-1">Session</span>
                <span className="ob-label">Updated</span>
              </div>
              {ROWS.map((r) => (
                <div
                  key={r.name}
                  className={cn('ob-transition flex h-7 items-center gap-3 border-b border-rule2 px-4 text-[12px] tracking-[-0.012em]', r.on ? 'ob-selected' : 'text-t2 hover:bg-hov hover:text-t1')}
                >
                  <span className="flex w-3 justify-center">
                    <StatusDot tone={r.tone} pulse={r.tone === 'violet'} />
                  </span>
                  <span className="flex-1 truncate">{r.name}</span>
                  <span className="hidden font-mono text-[9.5px] text-t3 xl:inline">{r.meta}</span>
                  <span className={cn('w-6 text-right font-mono text-[9.5px]', r.on ? 'text-acc' : 'text-t3')}>{r.time}</span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-8">
              <div>
                <SectionLabel action={<span className="text-acc">C:\FLOW</span>}>Disk</SectionLabel>
                <ProgressBar variant="segments" segments={18} value={0.45} tone="neutral" className="mb-2 mt-3" label="Disk" />
                {[
                  ['Free', '412 GB', 'text-ok'],
                  ['Writing', '3.1 GB/min', ''],
                  ['Headroom', '~2h 12m', 'text-warn'],
                ].map(([k, v, c]) => (
                  <div key={k} className="flex items-baseline justify-between py-[5px]">
                    <span className="text-[11.5px] text-t3">{k}</span>
                    <b className={cn('font-mono text-[11.5px] font-normal tracking-[-0.03em] text-t1', c)}>{v}</b>
                  </div>
                ))}
              </div>
              <div>
                <Card padding="sm">
                  <div className="text-[12.5px] font-medium tracking-[-0.016em]">Card = a plain section</div>
                  <div className="text-[11px] text-t3">No fill, no frame.</div>
                </Card>
                <Card padding="sm">
                  <div className="text-[12.5px] font-medium tracking-[-0.016em]">Consecutive cards</div>
                  <div className="text-[11px] text-t3">…are split by one hairline.</div>
                </Card>
              </div>
            </div>
          </Section>

          <Section title="Overlays">
            <Row>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button>Menu</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>Session</DropdownMenuLabel>
                  <DropdownMenuItem icon={Pencil} shortcut="F2">
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem icon={FileText} hint="md">
                    Export
                  </DropdownMenuItem>
                  <DropdownMenuCheckboxItem checked={checked} onCheckedChange={setChecked}>
                    Plan mode
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem icon={Trash2} danger>
                    Delete…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost">Popover</Button>
                </PopoverTrigger>
                <PopoverContent className="w-64">Popover content with a little explanation.</PopoverContent>
              </Popover>
              <Tooltip content="Tooltip text" shortcut="Ctrl+B">
                <Button variant="ghost">Tooltip</Button>
              </Tooltip>
              <Button variant="danger" onClick={() => setConfirm(true)}>
                Confirm…
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  toast({ title: 'GPU ready', body: 'Qwen3.8 27B is serving on RTX 5090', level: 'success' });
                  toast({ title: 'Budget warning', body: '85% of the monthly budget used', level: 'warning' });
                }}
              >
                Toasts
              </Button>
            </Row>
            <div className="flex items-center gap-[9px] rounded-[2px] px-3 py-[9px] shadow-[inset_0_0_0_1px_var(--err)]">
              <span className="text-[11.5px] font-medium text-err">F8 is bound twice</span>
              <span className="text-[11.5px] text-t2">Drop marker and Toggle multiview both claim it.</span>
              <Button size="sm" variant="danger" className="ml-auto">
                Resolve
              </Button>
            </div>
            <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete session?" description="This can't be undone." danger confirmLabel="Delete" onConfirm={() => undefined} />
          </Section>

          <Section title="Code block">
            <CodeBlock code={SAMPLE_TS} lang="ts" title="src/renderer/src/state/actions.ts" showLineNumbers startLine={120} />
          </Section>

          <Section title="Markdown">
            <Markdown text={SAMPLE_MD} />
          </Section>

          <Section title="Empty state" className="col-span-2">
            <EmptyState icon={FolderOpen} title="No changes yet" description="Files edited in this session will show up here." action={<Button size="sm">Open folder</Button>} />
          </Section>
        </div>
      </div>
    </div>
  );
}
