// Auto-scroll that follows new content while the user is at the bottom and stops as soon as THEY scroll up.
// Only user intent (wheel, touch, keys, scrollbar drag) can unpin; layout shifts (scroll anchoring, lazy
// content-visibility sizing, panel resizes) never do — the view simply re-pins. Owner: ui-chat.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const NEAR_PX = 56;
/** How long after a user gesture a scroll event counts as user-driven. */
const INTENT_MS = 350;

export interface StickToBottom {
  /** The viewport is (near) the bottom. */
  atBottom: boolean;
  /** Content grew while the user was scrolled up. */
  hasNew: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

export function useStickToBottom(scrollRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>, resetKey: string): StickToBottom {
  const stick = useRef(true);
  const intentAt = useRef(0);
  const dragging = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const lastHeight = useRef(0);

  const pin = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollRef]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const el = scrollRef.current;
      if (!el) return;
      stick.current = true;
      setAtBottom(true);
      setHasNew(false);
      el.scrollTo({ top: el.scrollHeight, behavior });
    },
    [scrollRef],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const userIntent = () => dragging.current || Date.now() - intentAt.current < INTENT_MS;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_PX;
      if (near) {
        stick.current = true;
        setHasNew(false);
      } else if (userIntent()) {
        stick.current = false;
      } else if (stick.current) {
        // A layout shift moved us away from the bottom: stay pinned.
        pin();
        return;
      }
      setAtBottom(near || stick.current);
    };
    const markIntent = () => {
      intentAt.current = Date.now();
    };
    const onWheel = (e: WheelEvent) => {
      markIntent();
      if (e.deltaY < 0 && el.scrollHeight > el.clientHeight) stick.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) markIntent();
    };
    const onPointerDown = (e: PointerEvent) => {
      // Scrollbar drags and text-selection drags start on the container itself.
      if (e.target === el || e.offsetX > el.clientWidth) dragging.current = true;
    };
    const onPointerUp = () => {
      if (dragging.current) markIntent();
      dragging.current = false;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', markIntent, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', markIntent);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
    };
    // resetKey: re-attach when the scroll container is (re)mounted.
  }, [scrollRef, pin, resetKey]);

  // Follow content growth (and viewport resizes).
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      const h = content.scrollHeight;
      const grew = h > lastHeight.current + 1;
      lastHeight.current = h;
      if (stick.current) pin();
      else if (grew) setHasNew(true);
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef, contentRef, pin, resetKey]);

  // New session / first load: start at the bottom.
  useLayoutEffect(() => {
    stick.current = true;
    setHasNew(false);
    setAtBottom(true);
    pin();
  }, [resetKey, pin]);

  return { atBottom, hasNew, scrollToBottom };
}
