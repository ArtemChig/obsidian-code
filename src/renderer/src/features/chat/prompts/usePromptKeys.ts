// Keyboard routing for inline prompt cards (permission / question / plan). Owner: ui-chat.
// The front-most card handles number keys, Enter and Esc when focus is NOT in a text field. Keys typed into the
// composer (empty or not) never answer a card: "1. also…" or an Esc meant for the field must not allow/deny a call.
// To keep the terminal-like flow, the card takes focus when it appears if nothing is being typed (see promptTakesFocus).
import { useEffect, useRef, type RefObject } from 'react';
import { promptKeyRoutes, promptTakesFocus, type FocusHolder } from '../lib/prompts';
import { isEditableTarget, overlayOpen } from '../ui';

let lastTypedAt = 0;
let trackingTyping = false;

/** Remember when the user last typed into any text field (so a card does not steal focus mid-sentence). */
function trackTyping(): void {
  if (trackingTyping || typeof window === 'undefined') return;
  trackingTyping = true;
  window.addEventListener(
    'keydown',
    (e) => {
      if (isEditableTarget(e.target)) lastTypedAt = Date.now();
    },
    { capture: true },
  );
}

function focusHolder(el: Element | null): FocusHolder {
  if (!el || el === document.body || el === document.documentElement) return 'none';
  if (!isEditableTarget(el)) return 'other';
  const composer = (el as HTMLElement).closest('[data-composer-input]') as HTMLTextAreaElement | null;
  if (composer) return composer.value.trim() === '' ? 'composer-empty' : 'composer-draft';
  return 'editable';
}

export function usePromptKeys(active: boolean, root: RefObject<HTMLElement | null>, handler: (e: KeyboardEvent) => boolean): void {
  const fn = useRef(handler);
  fn.current = handler;
  trackTyping();

  // Take focus when this card becomes the active one (only if nothing is being typed). Once it is answered (inactive)
  // while focus is still inside it, hand focus back to the composer so typing a follow-up just works.
  useEffect(() => {
    if (!active) return;
    const card = root.current;
    const t = setTimeout(() => {
      const el = root.current;
      if (!el || overlayOpen()) return;
      if (promptTakesFocus(focusHolder(document.activeElement), Date.now() - lastTypedAt)) el.focus({ preventScroll: true });
    }, 0);
    return () => {
      clearTimeout(t);
      if (card?.isConnected && card.contains(document.activeElement)) {
        document.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus({ preventScroll: true });
      }
    };
  }, [active, root]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (overlayOpen()) return;
      const t = e.target as HTMLElement | null;
      if (!promptKeyRoutes({ editable: isEditableTarget(t), inCard: !!(t && root.current?.contains(t)) })) return;
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
