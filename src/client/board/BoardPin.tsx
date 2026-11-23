import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { BoardRenderer, BoardSelection } from './BoardRenderer';

/**
 * 3D 보드의 한 자리(칸·꼭짓점·변) 바로 위에 children 을 붙인다. 보드를 끌거나 확대해도 렌더러가 그 자리를 따라 옮긴다.
 * 고른 자리 위의 ✓ / ✕ 단추와 핑 물결(center: 자리 한가운데)에 쓴다.
 */
export function BoardPin({ renderer, sel, center = false, children }: { renderer: BoardRenderer; sel: BoardSelection; center?: boolean; children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const pinned = renderer.pin(sel.kind, sel.id, center);
    setEl(pinned);
    return () => {
      if (pinned) renderer.unpin(pinned);
    };
  }, [renderer, sel.kind, sel.id, center]);
  return el ? createPortal(children, el) : null;
}
