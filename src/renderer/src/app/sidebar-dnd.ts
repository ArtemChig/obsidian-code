// Drag and drop state of the sidebar. The browser does not let a drop target read what is being dragged until the
// drop, so the dragged session / group and the marker to draw live here. Owner: ui-foundation.
import { create } from 'zustand';

export type DragItem =
  | { kind: 'session'; id: string }
  /** `order` = the display order of the groups when the drag started (to tell "above" from "below"). */
  | { kind: 'group'; key: string; order: string[] };

/** What the pointer is over, i.e. which marker to draw. */
export type DropMark =
  /** A line above / below a session row (the session lands there). */
  | { kind: 'row'; id: string; after: boolean }
  /** The whole group takes the session (on top). */
  | { kind: 'group'; key: string }
  /** A line above / below a group (the dragged group takes its place). */
  | { kind: 'slot'; key: string; edge: 'top' | 'bottom' };

interface DragStore {
  item: DragItem | null;
  mark: DropMark | null;
}

export const useSidebarDrag = create<DragStore>(() => ({ item: null, mark: null }));

export const startDrag = (item: DragItem): void => useSidebarDrag.setState({ item, mark: null });
export const endDrag = (): void => useSidebarDrag.setState({ item: null, mark: null });
export const dragItem = (): DragItem | null => useSidebarDrag.getState().item;

function sameMark(a: DropMark | null, b: DropMark | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'row') return a.id === (b as typeof a).id && a.after === (b as typeof a).after;
  if (a.kind === 'slot') return a.key === (b as typeof a).key && a.edge === (b as typeof a).edge;
  return a.key === (b as typeof a).key;
}

export function setMark(mark: DropMark | null): void {
  if (!sameMark(useSidebarDrag.getState().mark, mark)) useSidebarDrag.setState({ mark });
}
