import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { BoardRenderer, BoardSelection } from './BoardRenderer';

/**
 * 3D 보드의 한 자리(칸·꼭짓점·변) 바로 위에 children 을 붙인다. 보드를 끌거나 확대해도 렌더러가 그 자리를 따라 옮긴다.
 * 고른 자리 위의 ✓ / ✕ 단추에 쓴다.
 */
export function BoardPin({ renderer, sel, children }: { renderer: BoardRenderer; sel: BoardSelection; children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const pinned = renderer.pin(sel.kind, sel.id);
    setEl(pinned);
    return () => {
      if (pinned) renderer.unpin(pinned);
    };
  }, [renderer, sel.kind, sel.id]);
  return el ? createPortal(children, el) : null;
}
