// 승리 연출 박자: 처음 지은 차례대로 건물을 세고 달성·승점 카드를 더한 뒤 마무리한다 (3D 보드와 점수판이 같이 쓴다)
import { describe, expect, it } from 'vitest';
import { VICTORY_QUICK_PACE, victoryPlan, victoryStepLabel } from '../src/client/board/victory';

const VICTORY_FINALE_MS = VICTORY_QUICK_PACE.finale;
const VICTORY_STOP_MIN_MS = VICTORY_QUICK_PACE.stopMin;

const village = (vertexId: string) => ({ vertexId, kind: 'village' as const });
const city = (vertexId: string) => ({ vertexId, kind: 'city' as const });

describe('승리 연출 박자', () => {
  it('건물을 처음 지은 차례대로 세고, 최장 교역로·최강 기사단·승점 카드를 더해 최종 점수에 닿는다', () => {
    const plan = victoryPlan({
      buildings: [city('v1'), village('v2'), city('v3'), village('v4'), village('v5')],
      longestRoad: true,
      largestArmy: true,
      score: 13,
    });
    expect(plan.steps.map((s) => s.kind)).toEqual(['city', 'village', 'city', 'village', 'village', 'longest_road', 'largest_army', 'cards']);
    expect(plan.steps.slice(0, 5).map((s) => s.vertexId)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']);
    expect(plan.steps.map((s) => s.total)).toEqual([2, 3, 5, 6, 7, 9, 11, 13]);
    expect(plan.steps.at(-1)).toMatchObject({ kind: 'cards', points: 2, count: 2 });
    expect(victoryStepLabel(plan.steps.at(-1)!)).toBe('승점 카드 2장');
    expect(plan.score).toBe(13);
  });

  it('단계는 시간 순서대로 오고, 마무리 뒤 결과 창을 연다', () => {
    const plan = victoryPlan({ buildings: [village('a'), village('b'), city('c')], longestRoad: true, largestArmy: false, score: 6 });
    for (let i = 1; i < plan.steps.length; i++) expect(plan.steps[i].at).toBe(plan.steps[i - 1].at + plan.steps[i - 1].span);
    const last = plan.steps.at(-1)!;
    expect(plan.finaleAt).toBe(last.at + last.span);
    expect(plan.end).toBe(plan.finaleAt + VICTORY_FINALE_MS);
    // 승점 카드가 없으면 카드 단계도 없다.
    expect(plan.steps.some((s) => s.kind === 'cards')).toBe(false);
  });

  it('10점 승리는 5초 남짓에 끝나고, 건물이 많아도 7초를 넘지 않는다', () => {
    const typical = victoryPlan({
      buildings: [city('a'), village('b'), city('c'), village('d'), village('e'), village('f')],
      longestRoad: true,
      largestArmy: false,
      score: 10,
    });
    expect(typical.end).toBeGreaterThan(4500);
    expect(typical.end).toBeLessThanOrEqual(5600);
    const many = victoryPlan({
      buildings: Array.from({ length: 20 }, (_, i) => village(`v${i}`)),
      longestRoad: true,
      largestArmy: true,
      score: 25,
    });
    expect(many.end).toBeLessThanOrEqual(7000);
    for (const s of many.steps.filter((x) => x.vertexId)) expect(s.span).toBeGreaterThanOrEqual(VICTORY_STOP_MIN_MS);
  });

  it('길 위를 걷는 카메라는 건물마다 조금 더 머물고, 10점 승리면 7초 안팎이며 건물이 아주 많아도 10초를 넘지 않는다', () => {
    const buildings = [city('a'), village('b'), city('c'), village('d'), village('e'), village('f')];
    const quick = victoryPlan({ buildings, longestRoad: true, largestArmy: false, score: 10 });
    const walk = victoryPlan({ buildings, longestRoad: true, largestArmy: false, score: 10, walk: true });
    expect(walk.steps[0].span).toBeGreaterThan(quick.steps[0].span);
    expect(walk.steps.map((s) => s.total)).toEqual(quick.steps.map((s) => s.total));
    expect(walk.end).toBeGreaterThan(5500);
    expect(walk.end).toBeLessThanOrEqual(7500);
    const many = victoryPlan({ buildings: Array.from({ length: 20 }, (_, i) => village(`v${i}`)), longestRoad: true, largestArmy: true, score: 25, walk: true });
    expect(many.end).toBeLessThanOrEqual(10000);
  });

  it('건물이 하나도 없으면(실험실) 바로 마무리한다', () => {
    const plan = victoryPlan({ buildings: [], longestRoad: false, largestArmy: false, score: 0 });
    expect(plan.steps).toEqual([]);
    expect(plan.end).toBe(plan.finaleAt + VICTORY_FINALE_MS);
  });
});
