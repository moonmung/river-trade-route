// 승리 연출의 박자: 이긴 사람이 처음 지었던 차례대로 마을·도시를 한 곳씩 찾아가며 점수를 세고,
// 최장 교역로·최강 기사단·승점 카드를 더한 뒤 보드 전체로 물러나 승리를 알린다.
// 3D 보드(BoardRenderer.playVictory)의 카메라·빛과 화면 위 점수판(ui/spectacle 의 VictoryShow)·효과음이 같은 박자를 쓴다.
// 시각은 모두 연출 시작부터의 ms.
import { AWARD_POINTS, ISLAND_BONUS_POINTS, PIECE_POINTS } from '../../shared/constants';

export type VictoryStepKind = 'village' | 'city' | 'islands' | 'longest_road' | 'largest_army' | 'cards';

export interface VictoryStep {
  kind: VictoryStepKind;
  /** 카메라가 닿아 점수가 오르는 때 */
  at: number;
  /** 다음 단계가 시작하기까지 (이동 시간 포함) */
  span: number;
  /** 이 단계에서 더하는 점수 */
  points: number;
  /** 이 단계까지 센 점수 */
  total: number;
  /** 마을·도시가 선 꼭짓점 */
  vertexId?: string;
  /** 승점 카드 장수 */
  count?: number;
}

export interface VictoryPlan {
  steps: VictoryStep[];
  /** 보드 전체로 물러나 승리를 알리는 때 */
  finaleAt: number;
  /** 연출이 모두 끝나 결과 창을 여는 때 */
  end: number;
  /** 다 센 점수 */
  score: number;
}

export interface VictoryInput {
  /** 이긴 사람의 마을·도시, 처음 지은 차례대로 (도시는 처음 마을을 지은 자리) */
  buildings: readonly { vertexId: string; kind: 'village' | 'city' }[];
  longestRoad: boolean;
  largestArmy: boolean;
  /** 새 섬 보너스를 받은 작은 섬 수 (섬 맵) */
  islands?: number;
  /** 숨긴 승점 카드까지 더한 최종 점수 */
  score: number;
  /**
   * 카메라가 길 위로 내려가 걸으며 건물을 올려다보는지 (3D 보드). 걷는 데 시간이 더 들어 건물마다 조금 오래 머문다.
   * 아니면(2D 보드·동작 줄이기) 카메라 없이 점수만 빠르게 센다.
   */
  walk?: boolean;
}

/** 연출 박자 (ms) */
export interface VictoryPace {
  /** 첫 건물에 닿기까지: 위에서 길 위로 내려앉는 시간 */
  intro: number;
  /** 마을·도시를 모두 도는 데 쓰는 시간 (건물 수로 나눈다) */
  tour: number;
  /** 건물 하나에 머무는 시간의 하한·상한 */
  stopMin: number;
  stopMax: number;
  /** 건물이 아주 많아도 순회가 이보다 길어지지 않게 한다 (그때는 하한보다 짧게 머문다) */
  tourCap: number;
  /** 최장 교역로를 한 번 훑는 시간, 최강 기사단 동상이 뛰는 시간, 승점 카드를 펼치는 시간 */
  road: number;
  army: number;
  cards: number;
  /** 보드 전체로 물러나 승리를 알린 뒤 결과 창을 열기까지 */
  finale: number;
}

/** 길 위를 걷는 카메라 (3D 보드) */
export const VICTORY_WALK_PACE: VictoryPace = { intro: 850, tour: 3000, stopMin: 380, stopMax: 760, tourCap: 4600, road: 1200, army: 1000, cards: 550, finale: 1600 };
/** 카메라 없이 점수만 세는 박자 (2D 보드·동작 줄이기) */
export const VICTORY_QUICK_PACE: VictoryPace = { intro: 450, tour: 2400, stopMin: 90, stopMax: 520, tourCap: 2400, road: 900, army: 700, cards: 550, finale: 1500 };

export function victoryPlan(input: VictoryInput): VictoryPlan {
  const pace = input.walk ? VICTORY_WALK_PACE : VICTORY_QUICK_PACE;
  const steps: VictoryStep[] = [];
  let total = 0;
  const n = input.buildings.length;
  let stop = n ? Math.min(pace.stopMax, Math.max(pace.stopMin, pace.tour / n)) : 0;
  if (stop * n > pace.tourCap) stop = pace.tourCap / n;
  let t = pace.intro;
  for (const b of input.buildings) {
    const points = PIECE_POINTS[b.kind];
    total += points;
    steps.push({ kind: b.kind, at: t, span: stop, points, total, vertexId: b.vertexId });
    t += stop;
  }
  if (input.islands) {
    const points = input.islands * ISLAND_BONUS_POINTS;
    total += points;
    steps.push({ kind: 'islands', at: t, span: pace.cards, points, total, count: input.islands });
    t += pace.cards;
  }
  if (input.longestRoad) {
    total += AWARD_POINTS;
    steps.push({ kind: 'longest_road', at: t, span: pace.road, points: AWARD_POINTS, total });
    t += pace.road;
  }
  if (input.largestArmy) {
    total += AWARD_POINTS;
    steps.push({ kind: 'largest_army', at: t, span: pace.army, points: AWARD_POINTS, total });
    t += pace.army;
  }
  // 숨겨 두었던 승점 카드: 건물·달성으로 설명되지 않는 나머지 점수
  const cards = Math.max(0, input.score - total);
  if (cards > 0) {
    total += cards;
    steps.push({ kind: 'cards', at: t, span: pace.cards, points: cards, total, count: cards });
    t += pace.cards;
  }
  // 건물이 하나도 없으면(실험실) 바로 마무리로 넘어간다.
  const finaleAt = steps.length ? t : pace.intro;
  return { steps, finaleAt, end: finaleAt + pace.finale, score: total };
}

/** 점수판 아래 줄에 적는 단계 이름 */
export function victoryStepLabel(step: VictoryStep): string {
  switch (step.kind) {
    case 'village':
      return '마을';
    case 'city':
      return '도시';
    case 'islands':
      return `새 섬 ${step.count ?? 1}곳`;
    case 'longest_road':
      return '최장 교역로';
    case 'largest_army':
      return '최강 기사단';
    case 'cards':
      return `승점 카드 ${step.count ?? step.points}장`;
  }
}
