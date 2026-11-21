// 자원 카드가 보드에서 손으로 날아드는 연출.
// 내 생산은 맵이 한 번 밝아지면서 카드가 보드에서 내 손의 그 자원 카드 자리로 슉슉 날아들고, 다른 사람의 생산은 그 사람 상태 창
// 오른쪽 아래(손 카드 뭉치)로 작은 카드가 슈루룩 빨려 들어간다. 여러 장이면 그만큼 날아간다.
// 날아가는 동안 그 카드는 손 장수에서 빼 두었다가(hold) 닿는 순간 하나씩 더한다(release). 그래서 숫자가 카드가 닿을 때 올라간다.
import { useSyncExternalStore } from 'react';
import { RESOURCES, emptyBundle } from '../../shared/constants';
import type { Bundle, Resource } from '../../shared/types';
import { RESOURCE_ART } from '../ui/art';

/** 사람마다 아직 날아가는 중이라 손에 넣지 않은 카드 */
let held: Record<string, Bundle> = {};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

function adjust(player: string, resource: Resource, d: number): void {
  const cur = held[player] ?? emptyBundle();
  const next = { ...cur, [resource]: Math.max(0, cur[resource] + d) };
  held = { ...held, [player]: next };
  if (RESOURCES.every((r) => next[r] === 0)) {
    const { [player]: _gone, ...rest } = held;
    held = rest;
  }
  emit();
}

/** 날아가는 중인 카드 (사람별). 화면에 보이는 장수에서 뺀다. */
export function useHeldCards(): Record<string, Bundle> {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => held,
  );
}

export function heldTotal(h: Record<string, Bundle>, player: string): number {
  const b = h[player];
  return b ? RESOURCES.reduce((n, r) => n + b[r], 0) : 0;
}

/** 진행 중인 연출을 모두 거두고 장수를 바로 맞춘다 (게임 화면을 떠날 때, 새 게임). */
export function clearFlyingCards(): void {
  document.querySelectorAll('.fly-card').forEach((el) => el.remove());
  held = {};
  emit();
}

export interface FlyCard {
  player: string;
  resource: Resource;
  /** 출발 화면 좌표 (보드 위 칸·마을 자리) */
  from: { x: number; y: number };
  /** 연출 시작까지 기다리는 시간 (ms) */
  delay: number;
  /** 내 카드면 크게 내 손으로, 아니면 작게 그 사람 상태 창으로 */
  mine: boolean;
}

const MINE_MS = 760;
const OTHER_MS = 900;

function targetOf(card: FlyCard): Element | null {
  if (card.mine) return document.querySelector(`[data-fly="res-${card.resource}"]`) ?? document.querySelector('[data-fly="hand"]');
  return document.querySelector(`[data-fly="hand-${card.player}"]`);
}

function center(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function bump(el: Element | null): void {
  if (!el) return;
  el.classList.remove('fly-catch');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('fly-catch');
  window.setTimeout(() => el.classList.remove('fly-catch'), 420);
}

/**
 * 카드를 날린다. 장수는 바로 hold 해 두고, 카드가 닿으면 하나씩 release 한다.
 * 받을 자리를 찾지 못하거나(상태 창이 접혀 있음) 동작 줄이기를 켰으면 날리지 않고 바로 손에 넣는다.
 */
export function flyCards(cards: FlyCard[], opts: { reduced?: boolean } = {}): void {
  for (const card of cards) {
    adjust(card.player, card.resource, 1);
    let done = false;
    const land = () => {
      if (done) return;
      done = true;
      adjust(card.player, card.resource, -1);
    };
    // 화면이 숨겨져 애니메이션이 멈춰도 장수는 반드시 맞춘다.
    const safety = window.setTimeout(land, card.delay + (card.mine ? MINE_MS : OTHER_MS) + 1500);
    window.setTimeout(() => {
      const target = targetOf(card);
      if (opts.reduced || !target || document.visibilityState === 'hidden') {
        window.clearTimeout(safety);
        land();
        bump(target);
        return;
      }
      launch(card, target, () => {
        window.clearTimeout(safety);
        land();
        bump(targetOf(card) ?? target);
      });
    }, card.delay);
  }
}

function launch(card: FlyCard, target: Element, onLand: () => void): void {
  const el = document.createElement('div');
  el.className = `fly-card fly-${card.resource} ${card.mine ? 'fly-mine' : 'fly-other'}`;
  el.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = RESOURCE_ART[card.resource];
  img.alt = '';
  img.draggable = false;
  el.appendChild(img);
  document.body.appendChild(el);

  const to = center(target);
  const { x: x0, y: y0 } = card.from;
  const dx = to.x - x0;
  const dy = to.y - y0;
  // 카드가 칸에서 톡 솟았다가 곡선을 그리며 빨려 들어간다. 옆으로 조금씩 다른 쪽으로 휘게 한다.
  const swing = (Math.random() - 0.5) * 120;
  const lift = card.mine ? 70 : 46;
  const spin = (Math.random() - 0.5) * 50;
  const endScale = card.mine ? 0.9 : 0.42;
  const at = (fx: number, fy: number, s: number, r: number, o = 1) => ({
    transform: `translate(${(x0 + fx).toFixed(1)}px, ${(y0 + fy).toFixed(1)}px) translate(-50%, -50%) scale(${s}) rotate(${r.toFixed(1)}deg)`,
    opacity: o,
  });
  const anim = el.animate(
    [
      { ...at(0, 0, 0.2, spin), offset: 0, opacity: 0 },
      { ...at(swing * 0.15, -lift, card.mine ? 1.12 : 0.8, spin * 0.5), offset: 0.26 },
      { ...at(dx * 0.55 + swing, dy * 0.55 - lift * 0.9, card.mine ? 1.02 : 0.66, spin * 0.2), offset: 0.62 },
      { ...at(dx, dy, endScale, 0, 0.95), offset: 1 },
    ],
    { duration: card.mine ? MINE_MS : OTHER_MS, easing: 'cubic-bezier(0.45, 0, 0.25, 1)', fill: 'forwards' },
  );
  const finish = () => {
    el.remove();
    onLand();
  };
  anim.onfinish = finish;
  anim.oncancel = finish;
}

/** 맵이 한 번 환하게 밝아진다 (내 생산이 있을 때) */
export function glowBoard(): void {
  const el = document.querySelector('.board-layer');
  if (!el) return;
  el.classList.remove('board-glow');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('board-glow');
  window.setTimeout(() => el.classList.remove('board-glow'), 1300);
}
