// Browse + Favorites: a searchable list of Hugging Face GGUF repos on the left, the selected repo's details on the right.
// Below ~1000 px of width the two panes take turns (a repo opens full width with a way back). Owner: ui-views.
import { ArrowLeft, ArrowUpRight, Boxes, RefreshCw, Search, Star, X } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import type { HubModelSummary } from '@shared/hub';
import { Badge } from '@renderer/components/ui/badge';
import { Button, IconButton } from '@renderer/components/ui/button';
import { EmptyState, Skeleton } from '@renderer/components/ui/feedback';
import { Input } from '@renderer/components/ui/input';
import { Select } from '@renderer/components/ui/select';
import { RelativeTime } from '@renderer/components/ui/time';
import { cn } from '@renderer/lib/cn';
import { pluralize } from '@renderer/lib/format';
import { useSettings } from '@renderer/state/settings';
import { RepoDetail } from './RepoDetail';
import { compactCount, directRepo, parseIso, SORT_OPTIONS, splitRepo, TYPE_OPTIONS, addedCountFor, type TypeFilter } from './model';
import { FavoriteButton, Notice } from './parts';
import { loadDetails, loadMore, runSearch, selectRepo, setQuery, setSort, setType, toggleFavorite, useModels } from './store';

/** Shared by the header and the rows: star · model · downloads · likes · updated. */
const COLS = 'grid grid-cols-[22px_minmax(0,1fr)_50px_42px_46px] items-center gap-2 px-4';

type Mode = 'browse' | 'favorites';

export function RepoBrowser({ mode }: { mode: Mode }) {
  const selected = useModels((s) => s.selected);
  const settings = useSettings((s) => s.settings);
  const favorites = settings?.vast.favoriteRepos ?? [];

  // First visit: load the default list (most downloaded GGUF repos).
  const status = useModels((s) => s.status);
  useEffect(() => {
    if (mode === 'browse' && status === 'idle') void runSearch();
  }, [mode, status]);

  return (
    <div className="@container h-full min-h-0" data-testid={`models-${mode}`}>
      <div className="grid h-full min-h-0 grid-cols-1 @min-[1000px]:grid-cols-[minmax(380px,460px)_minmax(0,1fr)]">
        <section aria-label={mode === 'browse' ? 'Search results' : 'Favorites'} className={cn('flex min-h-0 min-w-0 flex-col @min-[1000px]:border-r @min-[1000px]:border-rule', selected && '@max-[999px]:hidden')}>
          {mode === 'browse' ? <Toolbar /> : null}
          {mode === 'browse' ? <ResultList /> : <FavoriteList repos={favorites} />}
        </section>
        <section aria-label="Model details" className={cn('min-h-0 min-w-0 overflow-y-auto', !selected && '@max-[999px]:hidden')}>
          {selected ? (
            <div className="border-b border-rule2 px-4 py-1.5 @min-[1000px]:hidden">
              <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={() => selectRepo(null)}>
                Back to the list
              </Button>
            </div>
          ) : null}
          <RepoDetail repo={selected} />
        </section>
      </div>
    </div>
  );
}

// ───────────────────────────── Toolbar ─────────────────────────────

function Toolbar() {
  const query = useModels((s) => s.query);
  const sort = useModels((s) => s.sort);
  const type = useModels((s) => s.type);
  const status = useModels((s) => s.status);
  return (
    <div className="flex flex-col gap-2 border-b border-rule px-4 py-3" data-testid="models-toolbar">
      <Input
        icon={Search}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void runSearch();
        }}
        placeholder="Search models, or paste owner/name or a Hugging Face link"
        aria-label="Search Hugging Face models"
        data-testid="models-search"
        trailing={
          query ? (
            <IconButton
              label="Clear search"
              size="xs"
              icon={X}
              onClick={() => {
                setQuery('');
                void runSearch();
              }}
            />
          ) : undefined
        }
      />
      <div className="flex items-center gap-2">
        <Select size="sm" value={sort} onValueChange={(v) => setSort(v as typeof sort)} options={SORT_OPTIONS} aria-label="Sort by" className="min-w-0 flex-1" />
        <Select size="sm" value={type} onValueChange={(v) => setType(v as TypeFilter)} options={TYPE_OPTIONS} aria-label="Model type" className="min-w-0 flex-1" />
        <IconButton label="Refresh results" size="sm" variant="secondary" icon={RefreshCw} loading={status === 'loading'} onClick={() => void runSearch({ refresh: true })} data-testid="models-refresh" />
      </div>
    </div>
  );
}

// ───────────────────────────── Lists ─────────────────────────────

function ListHeader({ children }: { children?: React.ReactNode }) {
  return (
    <div className={cn(COLS, 'ob-label h-7 shrink-0 border-b border-rule')} aria-hidden>
      <span />
      <span>{children ?? 'Model'}</span>
      <span className="text-right">Downloads</span>
      <span className="text-right">Likes</span>
      <span className="text-right">Updated</span>
    </div>
  );
}

function ResultList() {
  const results = useModels((s) => s.results);
  const status = useModels((s) => s.status);
  const error = useModels((s) => s.error);
  const stale = useModels((s) => s.stale);
  const fetchedAt = useModels((s) => s.fetchedAt);
  const nextCursor = useModels((s) => s.nextCursor);
  const query = useModels((s) => s.query);
  const selected = useModels((s) => s.selected);
  const settings = useSettings((s) => s.settings);
  const favorites = settings?.vast.favoriteRepos ?? [];
  const userModels = settings?.vast.userModels ?? [];

  const direct = useMemo(() => directRepo(query), [query]);
  const directShown = direct && !results.some((m) => m.repo.toLowerCase() === direct.repo.toLowerCase()) ? direct : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="models-results">
      <ListHeader />
      <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Models">
        {stale ? (
          <Notice tone="warning" testId="models-stale" action={<Button size="sm" variant="ghost" onClick={() => void runSearch({ refresh: true })}>Retry</Button>}>
            Hugging Face could not be reached. These results are from {fetchedAt ? <RelativeTime ts={fetchedAt} ago /> : 'earlier'}.
          </Notice>
        ) : null}
        {directShown ? (
          <div
            role="option"
            aria-selected={selected === directShown.repo}
            tabIndex={0}
            data-testid="models-open-direct"
            onClick={() => selectRepo(directShown.repo)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectRepo(directShown.repo);
              }
            }}
            className={cn('ob-transition flex h-7 cursor-default items-center gap-2 border-b border-rule2 px-4 text-[12px] outline-offset-[-2px]', selected === directShown.repo ? 'ob-selected' : 'hover:bg-hov')}
          >
            <ArrowUpRight size={12} aria-hidden className="shrink-0 text-t3" />
            <span className="truncate text-t1">
              Open <span className="font-mono text-[11px]">{directShown.repo}</span>
            </span>
          </div>
        ) : null}
        {status === 'loading' && results.length === 0 ? <ListSkeleton /> : null}
        {status === 'error' ? (
          <Notice tone="danger" testId="models-error" action={<Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => void runSearch()}>Retry</Button>}>
            {error}
          </Notice>
        ) : null}
        {status !== 'loading' && status !== 'error' && results.length === 0 && status !== 'idle' ? (
          <EmptyState icon={Boxes} size="sm" title="No models found" description={query.trim() ? 'Try another word, a different type, or paste the owner/name of a repo.' : 'Hugging Face returned nothing for this filter.'} />
        ) : null}
        {results.map((m) => (
          <RepoRow key={m.repo} summary={m} selected={selected === m.repo} favorite={favorites.includes(m.repo)} added={addedCountFor(userModels, m.repo)} />
        ))}
        {nextCursor ? (
          <div className="flex justify-center py-3">
            <Button size="sm" variant="secondary" loading={status === 'more'} onClick={() => void loadMore()} data-testid="models-load-more">
              Load more
            </Button>
          </div>
        ) : results.length > 0 ? (
          <div className="ob-mn px-4 py-3">
            <b>{pluralize(results.length, 'model')}</b> · end of the list
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FavoriteList({ repos }: { repos: string[] }) {
  const details = useModels((s) => s.details);
  const selected = useModels((s) => s.selected);
  const settings = useSettings((s) => s.settings);
  const userModels = settings?.vast.userModels ?? [];
  const key = repos.join('|');

  // Rows show downloads/likes/updated, which only the details carry: fetch them a few at a time.
  useEffect(() => {
    let alive = true;
    const todo = repos.filter((r) => !useModels.getState().details[r]);
    const worker = async () => {
      while (alive && todo.length) {
        const r = todo.shift();
        if (r) await loadDetails(r);
      }
    };
    void Promise.all([worker(), worker(), worker()]);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (repos.length === 0) {
    return (
      <EmptyState
        icon={Star}
        title="No favorites yet"
        description="Star a model while browsing to keep it here."
        action={
          <Button size="sm" variant="secondary" onClick={() => useModels.setState({ tab: 'browse' })}>
            Browse models
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="models-favorites-list">
      <ListHeader>Favorites</ListHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Favorites">
        {repos.map((repo) => {
          const d = details[repo];
          const summary: HubModelSummary | undefined = d?.data;
          return (
            <RepoRow
              key={repo}
              repo={repo}
              summary={summary}
              unavailable={d?.status === 'error'}
              selected={selected === repo}
              favorite
              added={addedCountFor(userModels, repo)}
            />
          );
        })}
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div aria-hidden className="flex flex-col">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className={cn(COLS, 'h-7 border-b border-rule2')}>
          <span />
          <Skeleton className="h-2.5 w-3/4" />
          <Skeleton className="ml-auto h-2.5 w-8" />
          <Skeleton className="ml-auto h-2.5 w-6" />
          <Skeleton className="ml-auto h-2.5 w-6" />
        </div>
      ))}
    </div>
  );
}

function RepoRow({
  summary,
  repo,
  selected,
  favorite,
  added,
  unavailable,
}: {
  summary?: HubModelSummary;
  repo?: string;
  selected: boolean;
  favorite: boolean;
  added: number;
  unavailable?: boolean;
}) {
  const id = summary?.repo ?? repo ?? '';
  const { author, name } = splitRepo(id);
  const updated = parseIso(summary?.lastModified);
  const open = () => selectRepo(id);
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      data-testid="models-row"
      data-repo={id}
      data-selected={selected || undefined}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      className={cn(COLS, 'ob-transition h-7 cursor-default border-b border-rule2 text-[12px] tracking-[-0.012em] outline-offset-[-2px]', selected ? 'ob-selected' : 'hover:bg-hov')}
    >
      <FavoriteButton on={favorite} size="xs" onToggle={() => void toggleFavorite(id)} />
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate" title={id}>
          <span className="text-t3">{author}/</span>
          <span className={selected ? 'text-t1' : 'text-t1'}>{name}</span>
        </span>
        {added > 0 ? <Badge tone="success">added</Badge> : null}
        {summary?.gated ? <Badge tone="warning">gated</Badge> : null}
        {unavailable ? <Badge tone="danger">unavailable</Badge> : null}
      </span>
      <span className="ob-num text-right font-mono text-[10.5px] tracking-[-0.02em] text-t2">{summary ? compactCount(summary.downloads) : '—'}</span>
      <span className="ob-num text-right font-mono text-[10.5px] tracking-[-0.02em] text-t2">{summary ? compactCount(summary.likes) : '—'}</span>
      <span className="ob-num text-right font-mono text-[10.5px] tracking-[-0.02em] text-t3">{updated ? <RelativeTime ts={updated} short /> : '—'}</span>
    </div>
  );
}
