import { describe, expect, it } from 'vitest';
import { harborLegs } from '../src/client/board/harborTrade';
import { emptyBundle } from '../src/shared/constants';
import type { Bundle, Harbor } from '../src/shared/types';

const harbors: Harbor[] = [
  { edgeId: 'e-any', resource: null },
  { edgeId: 'e-wool', resource: 'wool' },
  { edgeId: 'e-stone', resource: 'stone' },
];
const bundle = (b: Partial<Bundle>): Bundle => ({ ...emptyBundle(), ...b });

describe('harborLegs: 해상 교역로 배 연출의 부두 고르기', () => {
  it('그 자원 전용 교역로(2:1)를 아무 자원 교역로(3:1)보다 먼저 고른다', () => {
    const legs = harborLegs(harbors, () => true, bundle({ wool: 2 }), bundle({ brick: 1 }));
    expect(legs).toEqual([{ edgeId: 'e-wool', ratio: 2, give: ['wool', 'wool'], get: ['brick'] }]);
  });

  it('전용 교역로가 없으면 내 아무 자원 교역로(3:1)로 간다', () => {
    const owns = (id: string) => id === 'e-any';
    const legs = harborLegs(harbors, owns, bundle({ stone: 6 }), bundle({ wood: 1, grain: 1 }));
    expect(legs).toEqual([{ edgeId: 'e-any', ratio: 3, give: Array(6).fill('stone'), get: ['wood', 'grain'] }]);
  });

  it('내 마을·도시가 닿지 않은 교역로는 쓰지 않고, 은행(4:1)과 바꾼 몫은 뺀다', () => {
    const owns = (id: string) => id === 'e-wool';
    const legs = harborLegs(harbors, owns, bundle({ wood: 4, wool: 2 }), bundle({ brick: 1, stone: 1 }));
    expect(legs).toEqual([{ edgeId: 'e-wool', ratio: 2, give: ['wool', 'wool'], get: ['brick'] }]);
  });

  it('교역로를 하나도 못 쓰면 빈 목록', () => {
    expect(harborLegs(harbors, () => false, bundle({ wood: 4 }), bundle({ wool: 1 }))).toEqual([]);
  });
});
