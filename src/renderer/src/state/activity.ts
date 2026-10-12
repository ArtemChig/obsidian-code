// Activity (oversight) + scheduled tasks stores. Owner: ui-foundation.
import { create } from 'zustand';
import type { ActivityItem, ScheduledTask } from '@shared/types';

export interface ActivityStore {
  items: ActivityItem[];
  loaded: boolean;
}

export const useActivity = create<ActivityStore>(() => ({ items: [], loaded: false }));

export interface SchedulesStore {
  tasks: ScheduledTask[];
  loaded: boolean;
}

export const useSchedules = create<SchedulesStore>(() => ({ tasks: [], loaded: false }));
