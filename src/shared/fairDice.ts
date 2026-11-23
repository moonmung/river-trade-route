// 고르게 굴리는 주사위. 서버(규칙 엔진)가 주사위 값을 정할 때 쓴다.
//
// 두 주사위의 36가지 눈 조합을 카드 한 벌처럼 섞어 두고 한 장씩 뽑는다. 그래서 몇 턴만 지나도 숫자마다 나오는 횟수가
// 확률(점 개수)에 가깝게 맞춰지고 6·8 만 몰리거나 오래 안 나오는 일이 줄어든다. 남은 카드가 RESHUFFLE_AT 장보다 적어지면
// 새 벌로 바꿔서 끝물에 남은 숫자를 미리 셀 수 없게 한다.
// 카드마다 뽑힐 무게를 조금씩 다르게 준다.
// - 바로 앞(또는 그 앞) 굴림과 같은 합은 덜 나온다 (같은 숫자 연타 줄이기).
// - 7 은 그 사람이 지금까지 굴린 7 이 다른 사람 평균보다 많으면 덜, 적으면 더 나온다 (7 을 사람마다 고르게).
// - 7 이 아닌 합은 그 합으로 자원을 받는 사람 중 오래 아무것도 받지 못한 사람이 있으면 더 나온다 (가뭄 덜기).
// 무게는 한 벌 안에서 뽑는 순서만 바꾸므로 긴 판 전체의 숫자 분포는 확률에서 크게 벗어나지 않는다.

export type DiceMode = 'random' | 'balanced';
export const DICE_MODES: readonly DiceMode[] = ['balanced', 'random'];
export const DICE_MODE_LABEL: Record<DiceMode, string> = { balanced: '고르게', random: '무작위' };

export function normalizeDiceMode(v: unknown): DiceMode | null {
  return v === 'balanced' || v === 'random' ? v : null;
}

/** 고르게 굴리기에 필요한 기록 (게임 상태에 싣는다. 화면에는 보내지 않는다) */
export interface FairDiceState {
  /** 남은 눈 조합 카드 */
  deck: [number, number][];
  /** 최근 굴림의 합 (오래된 것부터, 최대 2개) */
  recent: number[];
  /** 사람마다 이어서 아무 자원도 받지 못한 굴림 수 */
  dry: Record<string, number>;
  /** 사람마다 자기 차례에 굴린 7 의 수 */
  sevens: Record<string, number>;
}

/** 남은 카드가 이보다 적으면 새 벌로 바꾼다 */
export const RESHUFFLE_AT = 6;
/** 무게: 바로 앞 굴림과 같은 합, 두 번 앞 굴림과 같은 합 */
const REPEAT_LAST = 0.4;
const REPEAT_PREV = 0.7;
/** 7 무게: 내 7 이 평균보다 하나 많을 때마다 이만큼 줄고, 적을 때마다 는다 (사이 값으로 묶는다) */
const SEVEN_STEP = 0.5;
const SEVEN_MIN = 0.3;
const SEVEN_MAX = 1.9;
/** 가뭄 덜기: 받는 사람마다 (받지 못한 굴림 수, 최대 DRY_CAP) × DRY_STEP 만큼 무게가 는다 (최대 DRY_MAX 배) */
const DRY_STEP = 0.1;
const DRY_CAP = 6;
const DRY_MAX = 2;

/** 36가지 눈 조합 한 벌 */
export function freshDiceDeck(): [number, number][] {
  const deck: [number, number][] = [];
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) deck.push([a, b]);
  return deck;
}

export function newFairDice(players: readonly string[]): FairDiceState {
  return {
    deck: freshDiceDeck(),
    recent: [],
    dry: Object.fromEntries(players.map((id) => [id, 0])),
    sevens: Object.fromEntries(players.map((id) => [id, 0])),
  };
}

/**
 * 카드 한 장의 무게. producers(total) 은 그 합이 나오면 자원을 받는 사람들.
 */
export function cardWeight(st: FairDiceState, roller: string, players: readonly string[], total: number, producers: (total: number) => readonly string[]): number {
  let w = 1;
  const last = st.recent[st.recent.length - 1];
  const prev = st.recent[st.recent.length - 2];
  if (last === total) w *= REPEAT_LAST;
  else if (prev === total) w *= REPEAT_PREV;
  if (total === 7) {
    const avg = players.reduce((n, id) => n + (st.sevens[id] ?? 0), 0) / Math.max(1, players.length);
    const diff = (st.sevens[roller] ?? 0) - avg;
    w *= Math.min(SEVEN_MAX, Math.max(SEVEN_MIN, 1 - SEVEN_STEP * diff));
  } else {
    const thirst = producers(total).reduce((n, id) => n + Math.min(DRY_CAP, st.dry[id] ?? 0), 0);
    w *= Math.min(DRY_MAX, 1 + DRY_STEP * thirst);
  }
  return w;
}

/**
 * 고르게 굴린다: 무게를 준 남은 카드에서 한 장을 뽑아 빼고 그 눈을 돌려준다. st 의 더미와 최근 합, 7 수를 고친다.
 * 생산 결과로 dry 를 고치는 것은 recordProduction 이 한다.
 */
export function drawFairDice(
  st: FairDiceState,
  roller: string,
  players: readonly string[],
  producers: (total: number) => readonly string[],
  random: () => number,
): [number, number] {
  if (st.deck.length < RESHUFFLE_AT) st.deck = freshDiceDeck();
  // 같은 합의 카드는 무게가 같으므로 합마다 한 번만 계산한다.
  const byTotal = new Map<number, number>();
  const weights = st.deck.map(([a, b]) => {
    const t = a + b;
    let w = byTotal.get(t);
    if (w === undefined) {
      w = cardWeight(st, roller, players, t, producers);
      byTotal.set(t, w);
    }
    return w;
  });
  const sum = weights.reduce((n, w) => n + w, 0);
  let pick = random() * sum;
  let idx = weights.length - 1;
  for (let i = 0; i < weights.length; i++) {
    pick -= weights[i];
    if (pick < 0) {
      idx = i;
      break;
    }
  }
  const [dice] = st.deck.splice(idx, 1);
  const total = dice[0] + dice[1];
  st.recent = [...st.recent, total].slice(-2);
  if (total === 7) st.sevens[roller] = (st.sevens[roller] ?? 0) + 1;
  return [dice[0], dice[1]];
}

/** 굴림으로 자원을 받은 사람은 가뭄을 0 으로, 못 받은 사람은 1 늘린다 (7 이면 모두 늘린다). */
export function recordProduction(st: FairDiceState, players: readonly string[], got: (id: string) => boolean): void {
  for (const id of players) st.dry[id] = got(id) ? 0 : (st.dry[id] ?? 0) + 1;
}
