// 최강 기사단 사열의 박자: 빈 광장에 병사가 한 줄씩 들어서고(북), 다 함께 칼을 치켜들어 경례하고(나팔),
// 칼을 내린 뒤 제자리걸음을 하다가 사라진다. 3D 보드(BoardRenderer)의 움직임과 효과음(sfx.army)이 같은 박자를 쓴다.
// 시각은 모두 연출 시작부터의 ms.

export interface ParadeTiming {
  /** 첫 줄이 들어서는 때 */
  start: number;
  /** 줄과 줄 사이 */
  gap: number;
  /** 줄 수와 한 줄의 병사 수 */
  ranks: number;
  files: number;
  /** 다 함께 칼을 치켜드는 때 */
  salute: number;
  /** 칼을 내리기 시작하는 때 (내리는 데 PARADE_LOWER_MS) */
  lower: number;
  /** 제자리걸음 한 걸음 */
  step: number;
  /** 작아지며 사라지기 시작하는 때 */
  fade: number;
  /** 다 사라진 때 */
  end: number;
}

export const PARADE_LOWER_MS = 300;

/** golden: 황금 기사단은 경례를 더 오래 한다 */
export function paradeTiming(golden: boolean): ParadeTiming {
  const start = 250;
  const gap = 380;
  const ranks = 3;
  const files = 4;
  const salute = start + (ranks - 1) * gap + 450;
  const lower = salute + (golden ? 1600 : 1200);
  const step = 260;
  const fade = lower + PARADE_LOWER_MS + step * 4;
  return { start, gap, ranks, files, salute, lower, step, fade, end: fade + 600 };
}
