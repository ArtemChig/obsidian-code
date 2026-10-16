// Models view: browse open-source GGUF models on Hugging Face, favorite them, add them for GPU clock-ins, and keep the
// recommended (built-in) list one tab away. Owner: ui-views.
import { ExternalLink } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@renderer/components/ui/button';
import { Skeleton } from '@renderer/components/ui/feedback';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { openExternal } from '@renderer/lib/bridge';
import { loadGpuCatalog } from '@renderer/state/actions';
import { useGpu } from '@renderer/state/gpu';
import { useSettings } from '@renderer/state/settings';
import { CoreMissing, SyncFailed, useCoreMissing, useSyncError } from '../settings/core-missing';
import { ViewHeader } from '../settings/view-kit';
import { MyModels } from './MyModels';
import { Recommended } from './Recommended';
import { RepoBrowser } from './RepoBrowser';
import { setTab, useModels, type ModelsTab } from './store';

export function ModelsView() {
  const tab = useModels((s) => s.tab);
  const settings = useSettings((s) => s.settings);
  const catalog = useGpu((s) => s.catalog);
  const coreMissing = useCoreMissing();
  const syncError = useSyncError('settings');

  useEffect(() => {
    if (!catalog) void loadGpuCatalog(false, true);
  }, [catalog]);

  if (!settings) {
    if (coreMissing) return <div className="h-full" data-testid="models-view"><CoreMissing what="The model browser" /></div>;
    if (syncError) return <div className="h-full" data-testid="models-view"><SyncFailed what="the settings" error={syncError} /></div>;
    return (
      <div className="h-full" data-testid="models-view">
        <ViewHeader title="Models" />
        <div className="flex flex-col gap-2 px-6 py-5" aria-hidden>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const favorites = settings.vast.favoriteRepos.length;
  const mine = settings.vast.userModels.length;
  const builtin = catalog ? catalog.filter((m) => m.source !== 'user').length : 0;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="models-view">
      <ViewHeader
        title="Models"
        description="Browse open-source models on Hugging Face and add them for GPU clock-ins. The recommended list stays available."
        actions={
          <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => openExternal('https://huggingface.co/models?library=gguf&sort=trending')}>
            huggingface.co
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as ModelsTab)} className="min-h-0 flex-1">
        <TabsList className="px-6" aria-label="Models">
          <TabsTrigger value="browse" data-testid="models-tab-browse">
            Browse
          </TabsTrigger>
          <TabsTrigger value="favorites" count={favorites} data-testid="models-tab-favorites">
            Favorites
          </TabsTrigger>
          <TabsTrigger value="mine" count={mine} data-testid="models-tab-mine">
            My models
          </TabsTrigger>
          <TabsTrigger value="recommended" count={builtin} data-testid="models-tab-recommended">
            Recommended
          </TabsTrigger>
        </TabsList>
        <TabsContent value="browse">
          <RepoBrowser mode="browse" />
        </TabsContent>
        <TabsContent value="favorites">
          <RepoBrowser mode="favorites" />
        </TabsContent>
        <TabsContent value="mine">
          <MyModels />
        </TabsContent>
        <TabsContent value="recommended">
          <Recommended />
        </TabsContent>
      </Tabs>
    </div>
  );
}
