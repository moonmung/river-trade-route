// 섬 맵의 항로 묶기: 이어 띄운 배는 항로 하나, 배는 섬에 닿은 쪽에서 출발한다
import { describe, expect, it } from 'vitest';
import { shipRoutes, type FleetLookup } from '../src/client/board/fleet';

// 꼭짓점 A(바닷가, a 의 마을) - w1 - w2 - w3 이 한 줄이고 w2 에서 w4 로 갈래가 난다. B 는 다른 바닷가.
const EDGES: Record<string, { a: string; b: string }> = {
  e1: { a: 'A', b: 'w1' },
  s1: { a: 'w1', b: 'w2' },
  s2: { a: 'w2', b: 'w3' },
  s3: { a: 'w2', b: 'w4' },
  s4: { a: 'w4', b: 'w5' },
  e9: { a: 'B', b: 'w9' },
};
const look: FleetLookup = {
  ends: (id) => EDGES[id] ?? null,
  isCoast: (v) => v === 'A' || v === 'B',
  ownsBuilding: (v, owner) => v === 'A' && owner === 'a',
};

describe('항로 묶기', () => {
  it('이어 띄운 배는 항로 하나이고, 내 마을에서 출발해 가장 길게 이어진 길을 오간다', () => {
    const ships = ['e1', 's1', 's2', 's3', 's4'].map((edgeId) => ({ edgeId, owner: 'a', colorIndex: 2 }));
    const routes = shipRoutes(ships, look);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ owner: 'a', colorIndex: 2, vertices: ['A', 'w1', 'w2', 'w4', 'w5'], edges: ['e1', 's1', 's3', 's4'] });
    expect(routes[0].all).toEqual(['e1', 's1', 's2', 's3', 's4']);
  });

  it('떨어진 배 무리와 다른 사람의 배는 따로 항로가 되고, 마을이 없으면 바닷가 끝에서 출발한다', () => {
    const routes = shipRoutes(
      [
        { edgeId: 'e1', owner: 'a', colorIndex: 0 },
        { edgeId: 'e9', owner: 'a', colorIndex: 0 },
        { edgeId: 's2', owner: 'b', colorIndex: 1 },
      ],
      look,
    );
    expect(routes.map((r) => [r.owner, r.vertices])).toEqual([
      ['a', ['A', 'w1']],
      ['a', ['B', 'w9']],
      ['b', ['w2', 'w3']],
    ]);
  });
});
