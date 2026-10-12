// Saving helpers for the Settings view: settings.update with a de-duplicated toast. Owner: ui-views.
import type { Settings } from '@shared/types';
import { updateSettings } from '@renderer/state/actions';
import { toast } from '@renderer/state/toasts';

export const SAVED_TOAST_ID = 'settings-saved';

/** settings.update with a (de-duplicated) success toast. Errors are toasted by updateSettings. */
export async function saveSettings(patch: Partial<Settings>, label = 'Saved'): Promise<boolean> {
  const r = await updateSettings(patch);
  if (r) toast({ id: SAVED_TOAST_ID, title: label, level: 'success', durationMs: 1800 });
  return !!r;
}

// settings.update deep-merges nested objects (core store + demo), so a patch carries ONLY the changed fields. Sending the whole
// nested object would let a slow earlier save overwrite a later edit (two quick edits in the same section).
export function patchVast(patch: Partial<Settings['vast']>, label?: string): Promise<boolean> {
  return saveSettings({ vast: patch as Settings['vast'] }, label);
}
export function patchLocal(patch: Partial<Settings['local']>, label?: string): Promise<boolean> {
  return saveSettings({ local: patch as Settings['local'] }, label);
}
export function patchSearch(patch: Partial<Settings['search']>, label?: string): Promise<boolean> {
  return saveSettings({ search: patch as Settings['search'] }, label);
}
export function patchPermissions(patch: Partial<Settings['permissions']>, label?: string): Promise<boolean> {
  return saveSettings({ permissions: patch as Settings['permissions'] }, label);
}
