// GPU view: rent an open-weight model on Vast.ai by the hour (profiles, model picker, clock in/out, spend, history, log). Owner: ui-views.
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@renderer/components/ui/button';
import { Skeleton } from '@renderer/components/ui/feedback';
import { SectionLabel } from '@renderer/components/ui/layout';
import { useLiveGpuCost, useModelLabel } from '@renderer/app/GpuWidget';
import { errorMessage, rpc } from '@renderer/lib/rpc';
import { clockIn, defaultGpuProfileId, loadGpuCatalog, navigate, requestClockOut, switchGpuModel } from '@renderer/state/actions';
import { isGpuClockedIn, useGpu } from '@renderer/state/gpu';
import { useSessions } from '@renderer/state/sessions';
import { useSettings } from '@renderer/state/settings';
import { toast } from '@renderer/state/toasts';
import { CoreMissing, useCoreMissing, SyncFailed, useSyncError } from '../settings/core-missing';
import { KeyRejectedBanner, NoKeyCard, OrphanBanner, ParkedCard, SafetyCard, SpendCard } from './Cards';
import { HistoryTable, ServerLog } from './HistoryAndLog';
import { useAccountCheck, useHistory, useIsConnected, useOffers } from './hooks';
import { ModelPicker } from './ModelPicker';
import { priceStats } from './model';
import { ProfileCards } from './ProfileCards';
import { SessionPanel } from './SessionPanel';

export function GpuView() {
  const status = useGpu((s) => s.status);
  const catalog = useGpu((s) => s.catalog);
  const hasApiKey = useGpu((s) => s.hasApiKey);
  const busy = useGpu((s) => s.busy);
  const settings = useSettings((s) => s.settings);
  const sessions = useSessions((s) => s.sessions);
  const connected = useIsConnected();
  const coreMissing = useCoreMissing();
  const syncError = useSyncError('gpu', 'settings');

  const profiles = settings?.vast.profiles;
  const profileList = useMemo(() => profiles ?? [], [profiles]);
  const active = isGpuClockedIn(status);
  const ready = status?.phase === 'ready';

  // ── selection (profile + model); locked to the running instance while clocked in
  const [profileSel, setProfileSel] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [showTest, setShowTest] = useState(false);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logReload, setLogReload] = useState(0);

  // "View server log" (error card) / "View" (safe-mode notice): open the log viewer and reload it (it scrolls itself
  // into view once loaded).
  const viewLog = useCallback(() => {
    setLogOpen(true);
    setLogReload((n) => n + 1);
  }, []);

  const wanted = active && status?.profileId ? status.profileId : (profileSel ?? defaultGpuProfileId());
  const profile = profileList.find((p) => p.id === wanted) ?? profileList[0];
  const profileId = profile?.id ?? '';
  const runningModelId = active && status?.profileId === profileId ? status.modelId : undefined;
  const modelId = picked[profileId] ?? runningModelId ?? profile?.defaultModelId ?? '';
  const pickedModel = catalog?.find((m) => m.id === modelId);

  // A clock-in started elsewhere (sidebar widget, tray, scheduler) defines the model that is "current".
  useEffect(() => {
    if (active && status?.profileId && status.modelId) {
      const pid = status.profileId;
      const mid = status.modelId;
      setPicked((p) => (p[pid] === mid ? p : { ...p, [pid]: mid }));
    }
  }, [active, status?.profileId, status?.modelId]);

  // ── data
  useEffect(() => {
    if (!connected || catalog) return;
    let alive = true;
    void loadGpuCatalog(false, true).then(() => {
      if (alive && !useGpu.getState().catalog) setCatalogFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [connected, catalog]);

  const profileIdsKey = profileList.map((p) => p.id).join('|');
  const ids = useMemo(() => (profileIdsKey ? profileIdsKey.split('|') : []), [profileIdsKey]);
  const offers = useOffers(ids, connected);
  const history = useHistory(50, connected);
  const account = useAccountCheck(hasApiKey, connected);

  const stats = priceStats(offers.byProfile[profileId]?.offers);
  const liveCost = useLiveGpuCost(status);
  const runningLabel = useModelLabel(status?.modelId);

  const defaultProvider = settings?.defaultModel?.provider;
  const runningSessions = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => s.kind !== 'subagent' && (s.status === 'running' || s.status === 'waiting') && (s.model?.provider ?? defaultProvider) === 'vast')
        .map((s) => s.title || 'Untitled session'),
    [sessions, defaultProvider],
  );

  // ── actions
  const onClockIn = useCallback(() => {
    if (!profile) return;
    void clockIn(profile.id, modelId || undefined);
  }, [profile, modelId]);

  const onSwitch = useCallback(async (id: string) => {
    setSwitching(true);
    try {
      await switchGpuModel(id);
    } finally {
      setSwitching(false);
    }
  }, []);

  const destroyOrphans = useCallback(async () => {
    try {
      const r = await rpc.request('gpu.destroyOrphans', {});
      toast({ title: r.destroyed.length ? `Destroyed ${r.destroyed.length} instance${r.destroyed.length === 1 ? '' : 's'}` : 'Nothing to destroy', body: r.destroyed.map((i) => `#${i}`).join(', ') || undefined, level: r.destroyed.length ? 'success' : 'info' });
      useGpu.setState({ status: await rpc.request('gpu.status', {}) });
    } catch (err) {
      toast({ title: 'Could not destroy the instances', body: errorMessage(err), level: 'error' });
    }
  }, []);

  const parkedId = status?.parked?.instanceId;
  const destroyParked = useCallback(async () => {
    try {
      // A user clock-out with nothing rented also discards the parked instance (stops its storage billing).
      const st = await rpc.request('gpu.clockOut', { reason: 'clock_out' });
      useGpu.setState({ status: st });
      // Only claim success when the instance is really gone (not still parked, nor left as unconfirmed).
      const left = parkedId !== undefined && (st.parked?.instanceId === parkedId || (st.orphanInstanceIds ?? []).includes(parkedId));
      if (left) {
        toast({ title: 'Destroy not confirmed', body: `Instance #${parkedId} may still exist; retrying in the background. Check console.vast.ai.`, level: 'warning' });
      } else toast({ title: 'Parked instance destroyed', level: 'success' });
    } catch (err) {
      toast({ title: 'Could not destroy the parked instance', body: errorMessage(err), level: 'error' });
    }
  }, [parkedId]);

  const resumeParked = useCallback(() => {
    const p = status?.parked;
    if (p) void clockIn(p.profileId, p.modelId);
  }, [status?.parked]);

  if (!status || !settings) {
    if (coreMissing) return <div className="h-full" data-testid="gpu-view"><CoreMissing what="GPU controls" /></div>;
    if (syncError) return <div className="h-full" data-testid="gpu-view"><SyncFailed what="the GPU status" error={syncError} /></div>;
    return <GpuSkeleton />;
  }

  const orphanIds = status.orphanInstanceIds ?? [];
  const accountRejected = hasApiKey && account.result && !account.result.ok;
  const anyLoading = Object.values(offers.byProfile).some((o) => o.state === 'loading');

  return (
    <div className="@container h-full overflow-y-auto" data-testid="gpu-view">
      <div className="flex min-h-full flex-col @min-[1000px]:flex-row">
        <div className="flex min-w-0 flex-1 flex-col pb-10">
          <SessionPanel
            status={status}
            profile={profile}
            pickedModel={pickedModel}
            runningModelLabel={runningLabel}
            stats={stats}
            hasApiKey={hasApiKey}
            busy={busy}
            runningSessions={runningSessions}
            idleMinutes={settings.vast.idleMinutes}
            maxSessionHours={settings.vast.maxSessionHours}
            parkedElsewhere={!!status.parked && !!profile && status.parked.profileId !== profile.id && !active}
            onClockIn={onClockIn}
            onClockOut={() => requestClockOut()}
            onViewLog={viewLog}
          />

          {orphanIds.length > 0 || hasApiKey === false || accountRejected ? (
            <div className="flex flex-col gap-2 px-[26px] pt-4">
              {orphanIds.length > 0 ? <OrphanBanner ids={orphanIds} onDestroy={destroyOrphans} /> : null}
              {hasApiKey === false ? <NoKeyCard /> : null}
              {accountRejected ? <KeyRejectedBanner message={account.result?.message ?? 'Unknown error'} /> : null}
            </div>
          ) : null}

          <section className="flex flex-col gap-2 px-[26px] pt-5" aria-label="Profiles">
            <SectionLabel
              rule
              action={
                <>
                  <span className="text-t3">{active ? 'locked while clocked in' : 'choose the hardware'}</span>
                  <Button size="sm" variant="ghost" icon={RefreshCw} loading={anyLoading} data-testid="gpu-refresh-prices" className="-mr-2.5 ml-1" onClick={offers.refreshAll}>
                    Refresh prices
                  </Button>
                </>
              }
            >
              Profile
            </SectionLabel>
            {profileList.length === 0 ? (
              <div className="border-y border-rule py-5 text-center text-[11.5px] text-t3">No GPU profiles are configured. Add one in Settings → Vast.ai.</div>
            ) : (
              <ProfileCards
                profiles={profileList}
                catalog={catalog}
                offers={offers.byProfile}
                selectedId={profileId}
                activeId={active ? status.profileId : undefined}
                locked={active}
                budget={status.monthlyBudget}
                monthCost={status.monthCost}
                onSelect={setProfileSel}
                onRefresh={(id) => void offers.refresh(id)}
              />
            )}
          </section>

          {profile ? (
            <section className="flex flex-col px-[26px] pt-6" aria-label="Model">
              <SectionLabel rule action={catalog && profile ? <span className="ob-tabular text-t3"><span className="text-t1">{catalog.length}</span> in catalog</span> : undefined}>
                Model
              </SectionLabel>
              <ModelPicker
                profile={profile}
                catalog={catalog}
                catalogError={catalogFailed}
                selectedId={modelId}
                currentId={runningModelId}
                canSwitch={ready && status.profileId === profile.id}
                switching={switching || status.phase === 'switching'}
                showTest={showTest}
                pricePerHour={status.pricePerHour ?? stats?.median}
                onShowTest={setShowTest}
                onSelect={(id) => setPicked((p) => ({ ...p, [profile.id]: id }))}
                onSwitch={(id) => void onSwitch(id)}
                onBrowse={() => navigate('models')}
                onRetryCatalog={() => {
                  setCatalogFailed(false);
                  void loadGpuCatalog(true, false).then(() => {
                    if (!useGpu.getState().catalog) setCatalogFailed(true);
                  });
                }}
              />
            </section>
          ) : null}

          <div className="flex flex-col gap-6 px-[26px] pt-5">
            <HistoryTable records={history.records} error={history.error} catalog={catalog} />
            <ServerLog
              live={status.phase !== 'off' && status.phase !== 'error'}
              open={logOpen}
              onOpenChange={setLogOpen}
              reloadKey={logReload}
              savedPath={status.failureLogPath}
            />
          </div>
        </div>

        <aside
          aria-label="Budget and safety"
          className="flex shrink-0 flex-col border-t border-rule @min-[1000px]:w-[298px] @min-[1000px]:border-t-0 @min-[1000px]:shadow-[inset_1px_0_0_var(--rule)]"
        >
          <SpendCard status={status} liveCost={liveCost} account={account.result} checking={account.checking} hasApiKey={hasApiKey} typicalPrice={status.pricePerHour ?? stats?.median} onRecheck={() => void account.check()} />
          {status.parked ? (
            <ParkedCard parked={status.parked} catalog={catalog} disabled={active || busy} busy={busy} parkMaxDays={settings.vast.parkMaxDays} onResume={resumeParked} onDestroy={destroyParked} />
          ) : null}
          <SafetyCard
            idleMinutes={settings.vast.idleMinutes}
            heartbeatMinutes={settings.vast.heartbeatMinutes}
            maxSessionHours={settings.vast.maxSessionHours}
            clockOutOnQuit={settings.vast.clockOutOnQuit}
            clockOutMode={settings.vast.clockOutMode}
          />
        </aside>
      </div>
    </div>
  );
}

function GpuSkeleton() {
  return (
    <div className="h-full overflow-y-auto" data-testid="gpu-view" aria-busy>
      <div className="flex flex-col gap-5 px-[26px] pt-[19px]" aria-hidden>
        <div className="flex items-start justify-between gap-6 border-b border-rule2 pb-4">
          <div className="flex flex-col gap-2.5">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-2.5 w-64" />
          </div>
          <Skeleton className="h-8 w-40" />
        </div>
        <Skeleton className="h-2.5 w-full" />
        <div className="grid grid-cols-3 gap-6">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    </div>
  );
}
