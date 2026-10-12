// UI kit gallery for design review: open http://localhost:5173/?demo=1&gallery=1. Owner: ui-foundation.
import { Bell, Download, FileText, FolderOpen, Pencil, Play, Plus, Search, Settings, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CodeBlock,
  ConfirmDialog,
  DropdownMenu,
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

const TONES: Tone[] = ['neutral', 'accent', 'success', 'warning', 'danger', 'violet'];

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>{title}</SectionLabel>
      <Card padding="lg" className="flex flex-col gap-4">
        {children}
      </Card>
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function Gallery() {
  const [sw, setSw] = useState(true);
  const [cb, setCb] = useState<boolean | 'indeterminate'>(true);
  const [sel, setSel] = useState('local');
  const [confirm, setConfirm] = useState(false);
  const [text, setText] = useState('Auto-growing textarea.\nAdd lines to see it grow.');
  return (
    <div className="h-full overflow-y-auto bg-ob-bg" data-testid="gallery">
      <div className="mx-auto grid max-w-[1200px] grid-cols-2 gap-6 p-8">
        <div className="col-span-2 flex items-center justify-between">
          <h1 className="text-title font-semibold">Obsidian UI kit</h1>
          <Shortcut keys="Ctrl+K" />
        </div>

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
              Small
            </Button>
            <Button size="md">Medium</Button>
            <Button size="lg" variant="primary" icon={Play}>
              Large
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
          </Row>
        </Section>

        <Section title="Badges & status">
          <Row>
            {TONES.map((t) => (
              <Badge key={t} tone={t}>
                {t}
              </Badge>
            ))}
          </Row>
          <Row>
            {TONES.map((t) => (
              <Badge key={t} tone={t} variant="outline" mono>
                {t}
              </Badge>
            ))}
          </Row>
          <Row>
            {TONES.map((t) => (
              <span key={t} className="flex items-center gap-1.5 text-small text-ob-text-2">
                <StatusDot tone={t} glow /> {t}
              </span>
            ))}
            <span className="flex items-center gap-1.5 text-small text-ob-text-2">
              <StatusDot tone="accent" pulse /> pulse
            </span>
          </Row>
          <Row>
            <Kbd>Esc</Kbd>
            <Shortcut keys="Ctrl+Shift+P" />
            <Spinner />
            <Spinner size={16} className="text-ob-accent" />
            <RelativeTime ts={Date.now() - 3_600_000 * 5} className="text-small text-ob-text-3" />
            <LiveDuration since={Date.now() - 125_000} className="font-mono text-small" />
          </Row>
        </Section>

        <Section title="Inputs">
          <Field label="Session title" description="Shown in the sidebar">
            <Input placeholder="Untitled" />
          </Field>
          <Row>
            <Input icon={Search} placeholder="Search…" wrapperClassName="w-60" />
            <Input invalid defaultValue="bad value" className="w-40" />
            <Input mono defaultValue="http://127.0.0.1:8080" className="w-56" />
          </Row>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} minRows={2} maxRows={6} />
          <Row>
            <Select
              value={sel}
              onValueChange={setSel}
              className="w-56"
              aria-label="Provider"
              groups={[
                { label: 'Local', options: [{ value: 'local', label: 'llama-server', description: '127.0.0.1:8080' }] },
                { label: 'Cloud', options: [{ value: 'vast', label: 'Vast GPU' }, { value: 'or', label: 'OpenRouter', disabled: true }] },
              ]}
            />
            <Switch checked={sw} onCheckedChange={setSw} label="Thinking" />
            <Checkbox checked={cb} onCheckedChange={setCb} label="Also restore files" />
            <Checkbox checked="indeterminate" onCheckedChange={() => {}} aria-label="Mixed" />
          </Row>
          <Field inline label="Clock out on quit" description="Destroy the GPU instance when the app closes">
            <Switch checked={sw} onCheckedChange={setSw} aria-label="Clock out on quit" />
          </Field>
        </Section>

        <Section title="Tabs, progress, overlays">
          <Tabs defaultValue="changes">
            <TabsList>
              <TabsTrigger value="changes" count={3}>
                Changes
              </TabsTrigger>
              <TabsTrigger value="todos">Todos</TabsTrigger>
              <TabsTrigger value="agents" count={1}>
                Agents
              </TabsTrigger>
            </TabsList>
            <TabsContent value="changes" className="py-3 text-small text-ob-text-2">
              Underline tabs for panels.
            </TabsContent>
          </Tabs>
          <Tabs defaultValue="unc">
            <TabsList variant="pill">
              <TabsTrigger value="unc">Uncensored</TabsTrigger>
              <TabsTrigger value="std">Standard</TabsTrigger>
            </TabsList>
          </Tabs>
          <ProgressBar value={0.42} />
          <ProgressBar value={0.85} tone="warning" size="md" />
          <ProgressBar value={null} tone="violet" />
          <div className="flex flex-col gap-2">
            <Skeleton className="w-2/3" />
            <Skeleton className="w-1/3" />
          </div>
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
          <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete session?" description="This can't be undone." danger confirmLabel="Delete" onConfirm={() => undefined} />
        </Section>

        <Section title="Code block">
          <CodeBlock code={SAMPLE_TS} lang="ts" title="src/renderer/src/state/actions.ts" showLineNumbers startLine={120} />
        </Section>

        <Section title="Markdown">
          <Markdown text={SAMPLE_MD} />
        </Section>

        <div className="col-span-2">
          <Card>
            <EmptyState icon={FolderOpen} title="No changes yet" description="Files edited in this session will show up here." action={<Button size="sm">Open folder</Button>} />
          </Card>
        </div>
      </div>
    </div>
  );
}
