// Models & providers store (models.list / models.updated). Owner: ui-foundation.
import { create } from 'zustand';
import type { ModelInfo, ProviderInfo } from '@shared/types';

export interface ModelsStore {
  providers: ProviderInfo[];
  models: ModelInfo[];
  loaded: boolean;
  refreshing: boolean;
}

export const useModels = create<ModelsStore>(() => ({ providers: [], models: [], loaded: false, refreshing: false }));
