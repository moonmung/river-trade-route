// 주사위 연출의 입구: 던지기(내 차례), 서버가 정한 값으로 멈추기, 멈춘 뒤 합계 띄우기.
// 3D 를 그릴 수 없는 기기(WebGL 없음)에서는 예전 2D 주사위 그림으로 대신한다.
import { useSyncExternalStore } from 'react';
import { sendAction } from '../game/ui';
import { DiceStage, REST_MS, REST_SEVEN_MS, type StageMode } from './DiceStage';

export interface DiceShow {
  id: number;
  dice: [number, number];
  who: string;
  colorIndex: number;
  /** 합계를 띄울 화면 좌표. null 이면 2D 대체 연출(화면 가운데) */
  at: { x: number; y: number } | null;
}

export interface DiceUi {
  mode: StageMode;
  /** 내가 던져 서버 값을 기다리는 중 */
  throwing: boolean;
  show: DiceShow | null;
}

let ui: DiceUi = { mode: 'off', throwing: false, show: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<DiceUi>) => {
  ui = { ...ui, ...patch };
  listeners.forEach((fn) => fn());
};

let stage: DiceStage | null | undefined;
let nextId = 1;
let pending: Promise<boolean> | null = null;

/** 3D 주사위 장면 (처음 쓸 때 만든다). WebGL 을 쓸 수 없으면 null. */
function getStage(): DiceStage | null {
  if (stage !== undefined) return stage;
  try {
    stage = new DiceStage({ onMode: (mode) => set({ mode }) });
    if (import.meta.env.DEV) Object.assign(window, { __diceStage: stage, __diceUi: () => ui });
  } catch {
    stage = null;
  }
  return stage;
}

export function useDiceUi(): DiceUi {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => ui,
  );
}

/** 3D 주사위를 그릴 수 있는지 */
export function dice3d(): boolean {
  return !!getStage();
}

export const tray = {
  show(el: HTMLElement, faces: [number, number]) {
    getStage()?.showTray(el, faces);
  },
  hide() {
    stage?.hideTray();
  },
  setHidden(hidden: boolean) {
    stage?.setTrayHidden(hidden);
  },
  grab(x: number, y: number) {
    getStage()?.grab(x, y);
  },
  drag(x: number, y: number) {
    stage?.drag(x, y);
  },
  drop() {
    stage?.drop();
  },
};

/**
 * 내 주사위를 던진다: 주사위는 바로 날아가기 시작하고, 그사이 서버에 굴리기를 보낸다.
 * 서버가 거절하면 날던 주사위를 거둔다. 이미 던져 기다리는 중이면 그 결과를 돌려준다.
 */
export function throwDice(): Promise<boolean> {
  if (pending) return pending;
  // 던지기 자리가 닫히기 전에(들고 있던 손의 자세와 빠르기가 남아 있을 때) 먼저 던진다.
  getStage()?.throwMine();
  set({ throwing: true });
  pending = sendAction({ type: 'roll' }).then((ok) => {
    pending = null;
    if (!ok && ui.throwing) {
      stage?.cancel();
      set({ throwing: false });
    }
    return ok;
  });
  return pending;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * 서버가 정한 주사위 값을 보여 준다. 내가 던진 주사위가 날고 있으면 그 주사위가 이 값으로 멈추고,
 * 아니면(남의 굴림) 화면 위쪽에서 주사위가 날아든다. 주사위가 다 멈추면 resolve 한다.
 */
export async function rollDice(
  dice: [number, number],
  info: { who: string; colorIndex: number; mine: boolean; animate: boolean },
): Promise<void> {
  const local = info.mine && ui.throwing;
  if (local) set({ throwing: false });
  if (!local && !info.animate) return;
  const s = getStage();
  const total = dice[0] + dice[1];
  const id = nextId++;
  const hold = total === 7 ? REST_SEVEN_MS : REST_MS;
  if (!s) {
    // 2D 대체: 화면 가운데에서 주사위 그림이 굴러와 멈춘다 (약 1.1초).
    set({ show: { id, dice, who: info.who, colorIndex: info.colorIndex, at: null } });
    window.setTimeout(() => ui.show?.id === id && set({ show: null }), 1700);
    await sleep(1100);
    return;
  }
  const spot = await s.reveal(dice, local ? null : info.mine ? 'near' : 'far');
  if (spot.interrupted) return;
  set({ show: { id, dice, who: info.who, colorIndex: info.colorIndex, at: { x: spot.x, y: spot.y } } });
  window.setTimeout(() => ui.show?.id === id && set({ show: null }), hold + 450);
}
