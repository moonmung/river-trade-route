import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'join'; code: string }
  | { name: 'room'; code: string }
  | { name: 'lab' };

function parse(pathname: string): Route {
  const join = /^\/join\/([^/]+)\/?$/i.exec(pathname);
  if (join) return { name: 'join', code: decodeURIComponent(join[1]).toUpperCase() };
  const room = /^\/room\/([^/]+)\/?$/i.exec(pathname);
  if (room) return { name: 'room', code: decodeURIComponent(room[1]).toUpperCase() };
  if (/^\/lab\/?$/i.test(pathname)) return { name: 'lab' };
  return { name: 'home' };
}

const listeners = new Set<() => void>();
let current = parse(window.location.pathname);

window.addEventListener('popstate', () => {
  current = parse(window.location.pathname);
  listeners.forEach((fn) => fn());
});

export function navigate(path: string, replace = false): void {
  if (window.location.pathname === path) return;
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  current = parse(path);
  listeners.forEach((fn) => fn());
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}
