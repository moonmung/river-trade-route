// 연출이 끝나기 전에 다음 행동이 열리지 않게 잠깐 미룬다.
// 서버는 굴리기·동상 옮기기를 받자마자 다음 단계로 넘어가지만, 화면은 주사위가 멈추고 합계를 읽을 틈이 지나고
// 생산한 카드가 손에 다 닿을 때까지, 옮긴 동상이 내려앉을 때까지 그 단계의 버튼·창·빛나는 자리를 열지 않는다.
// 남의 굴림도 같다 (주사위가 날아드는 동안 내 버리기 창이 먼저 뜨지 않는다). 차례 시간은 서버가 그대로 잰다.
import { useSyncExternalStore } from 'react';
import type { RoomView } from '../../shared/protocol';
import type { GameEvent } from '../../shared/types';
import { diceState, useDiceUi } from '../dice';
import { cardsFlying, useHeldCards } from './cardFly';

type Paced = 'roll' | 'robber';

/** 연출이 끝나 다음 행동을 열어도 되는 마지막 기록 번호. null 이면 아직 화면을 받기 전이라 기다리지 않는다. */
let done: Record<Paced, number | null> = { roll: null, robber: null };
/** 새 게임·새로 받은 화면마다 바뀐다. 지난 게임의 늦은 타이머가 새 게임의 기록 번호를 건드리지 않게 한다. */
let epoch = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** 무슨 일이 생겨도 이 시간이 지나면 연다 (주사위 연출이 끊긴 때 등) */
const SAFETY_MS = 9000;

const WAIT_TEXT = {
  dice: '주사위 굴리는 중…',
  goods: '생산한 자원을 받는 중…',
  robber: '기사단 동상을 옮기는 중…',
} as const;

function lastSeq(events: readonly GameEvent[], kind: Paced): number {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === kind) return events[i].seq;
  return 0;
}

function pending(events: readonly GameEvent[], kind: Paced): boolean {
  const d = done[kind];
  return d !== null && lastSeq(events, kind) > d;
}

/** 처음 받은 화면(새로고침·재접속·새 게임): 지난 굴림·동상은 끝난 것으로 쳐서 기다리지 않는다. */
export function resetPace(events: readonly GameEvent[]): void {
  epoch += 1;
  done = { roll: lastSeq(events, 'roll'), robber: lastSeq(events, 'robber') };
  emit();
}

/**
 * 새로 들어온 굴림·동상 옮기기의 연출을 시작한다. 돌려준 함수를 부르면(ms 를 주면 그만큼 뒤에) 다음 행동을 연다.
 * 부르지 못한 채 끝나도 SAFETY_MS 뒤에는 연다.
 */
export function startPaced(kind: Paced, seq: number): (afterMs?: number) => void {
  const e = epoch;
  const open = () => {
    if (e !== epoch || (done[kind] ?? -1) >= seq) return;
    done = { ...done, [kind]: seq };
    emit();
  };
  window.setTimeout(open, SAFETY_MS);
  return (ms = 0) => (ms > 0 ? window.setTimeout(open, ms) : open());
}

function waitFor(events: readonly GameEvent[], throwing: boolean, flying: boolean): keyof typeof WAIT_TEXT | null {
  if (throwing || pending(events, 'roll')) return 'dice';
  if (flying) return 'goods';
  if (pending(events, 'robber')) return 'robber';
  return null;
}

/**
 * 지금 연출을 기다리는 중이면 그 까닭(화면에 띄울 짧은 말), 아니면 null.
 * 기다리는 동안 게임 화면은 단계에 따라 열리는 것(동상 칸 빛, 버리기·빼앗기 창, 건설·교환·턴 종료 버튼)을 미룬다.
 * 생산 카드는 내 손으로 오는 것만 기다린다 (버튼이 보는 자원이 그 카드다). 남의 카드가 날아가는 동안은 막지 않는다.
 */
export function usePaceWait(view: RoomView): string | null {
  useSyncExternalStore(subscribe, () => done);
  const dice = useDiceUi();
  const held = useHeldCards();
  const g = view.game;
  if (!g || g.phase !== 'playing') return null;
  const w = waitFor(g.events, dice.throwing, !!held[view.you]);
  return w && WAIT_TEXT[w];
}

/** React 밖(실험실 봇)에서 볼 때: 화면이 아직 연출을 보여 주는 중인지. 봇은 누구의 카드든 다 닿을 때까지 기다린다. */
export function paceBusy(events: readonly GameEvent[]): boolean {
  return waitFor(events, diceState().throwing, cardsFlying()) !== null;
}
