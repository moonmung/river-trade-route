// 승리 연출의 박자: 이긴 사람이 처음 지었던 차례대로 마을·도시를 한 곳씩 찾아가며 점수를 세고,
// 최장 교역로·최강 기사단·승점 카드를 더한 뒤 보드 전체로 물러나 승리를 알린다.
// 3D 보드(BoardRenderer.playVictory)의 카메라·빛과 화면 위 점수판(ui/spectacle 의 VictoryShow)·효과음이 같은 박자를 쓴다.
// 시각은 모두 연출 시작부터의 ms.
import { AWARD_POINTS, PIECE_POINTS } from '../../shared/constants';

export type VictoryStepKind = 'village' | 'city' | 'longest_road' | 'largest_army' | 'cards';

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
  /** 숨긴 승점 카드까지 더한 최종 점수 */
  score: number;
}

/** 첫 건물로 카메라가 날아가는 시간 */
export const VICTORY_INTRO_MS = 450;
/** 마을·도시를 모두 도는 데 쓰는 시간 (건물 수로 나눈다) */
export const VICTORY_TOUR_MS = 2400;
/** 건물 하나에 머무는 시간의 하한·상한 (건물이 아주 많으면 빠르게 훑어 순회 시간을 넘기지 않는다) */
export const VICTORY_STOP_MIN_MS = 90;
export const VICTORY_STOP_MAX_MS = 520;
/** 최장 교역로를 한 번 훑는 시간, 최강 기사단 동상이 뛰는 시간, 승점 카드를 펼치는 시간 */
export const VICTORY_ROAD_MS = 900;
export const VICTORY_ARMY_MS = 700;
export const VICTORY_CARDS_MS = 550;
/** 보드 전체로 물러나 승리를 알린 뒤 결과 창을 열기까지 */
export const VICTORY_FINALE_MS = 1500;

export function victoryPlan(input: VictoryInput): VictoryPlan {
  const steps: VictoryStep[] = [];
  let total = 0;
  const n = input.buildings.length;
  const stop = n ? Math.min(VICTORY_STOP_MAX_MS, Math.max(VICTORY_STOP_MIN_MS, VICTORY_TOUR_MS / n)) : 0;
  let t = VICTORY_INTRO_MS;
  for (const b of input.buildings) {
    const points = PIECE_POINTS[b.kind];
    total += points;
    steps.push({ kind: b.kind, at: t, span: stop, points, total, vertexId: b.vertexId });
    t += stop;
  }
  if (input.longestRoad) {
    total += AWARD_POINTS;
    steps.push({ kind: 'longest_road', at: t, span: VICTORY_ROAD_MS, points: AWARD_POINTS, total });
    t += VICTORY_ROAD_MS;
  }
  if (input.largestArmy) {
    total += AWARD_POINTS;
    steps.push({ kind: 'largest_army', at: t, span: VICTORY_ARMY_MS, points: AWARD_POINTS, total });
    t += VICTORY_ARMY_MS;
  }
  // 숨겨 두었던 승점 카드: 건물·달성으로 설명되지 않는 나머지 점수
  const cards = Math.max(0, input.score - total);
  if (cards > 0) {
    total += cards;
    steps.push({ kind: 'cards', at: t, span: VICTORY_CARDS_MS, points: cards, total, count: cards });
    t += VICTORY_CARDS_MS;
  }
  // 건물이 하나도 없으면(실험실) 바로 마무리로 넘어간다.
  const finaleAt = steps.length ? t : VICTORY_INTRO_MS;
  return { steps, finaleAt, end: finaleAt + VICTORY_FINALE_MS, score: total };
}

/** 점수판 아래 줄에 적는 단계 이름 */
export function victoryStepLabel(step: VictoryStep): string {
  switch (step.kind) {
    case 'village':
      return '마을';
    case 'city':
      return '도시';
    case 'longest_road':
      return '최장 교역로';
    case 'largest_army':
      return '최강 기사단';
    case 'cards':
      return `승점 카드 ${step.count ?? step.points}장`;
  }
}
