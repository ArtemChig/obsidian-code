// Keyboard routing for inline prompt cards (permission / question / plan). Owner: ui-chat.
// The front-most card handles number keys, Enter and Esc when focus is not in some other text field — typing into an
// EMPTY composer still reaches the card (like a terminal prompt), a composer with a draft keeps its keys.
import { useEffect, useRef, type RefObject } from 'react';
import { isEditableTarget, overlayOpen } from '../ui';

export function usePromptKeys(active: boolean, root: RefObject<HTMLElement | null>, handler: (e: KeyboardEvent) => boolean): void {
  const fn = useRef(handler);
  fn.current = handler;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (overlayOpen()) return;
      const t = e.target as HTMLElement | null;
      if (isEditableTarget(t)) {
        const inCard = !!(t && root.current?.contains(t));
        if (inCard) return; // the card's own inputs handle their keys
        const composer = t?.closest('[data-composer-input]') as HTMLTextAreaElement | null;
        if (!composer || composer.value.trim() !== '') return;
      }
      if (fn.current(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [active, root]);
}

/** Map "1".."9" (top row or numpad) to 1..9, else 0. */
export function digitOf(e: KeyboardEvent): number {
  if (/^[1-9]$/.test(e.key)) return Number(e.key);
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  return m && !e.shiftKey ? Number(m[1]) : 0;
}
