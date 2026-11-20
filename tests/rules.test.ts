import { describe, expect, it } from 'vitest';
import { EDGES, HARBORS, VERTEX_MAP, VERTICES, assignNumbers, coastEdges, edgeBetween, edgeLabel, harborVertices, vertexAt, vertexLabel } from '../src/shared/board';
import { DEV_DECK, NEIGHBORS, PIECE_COST, RESOURCES, TILES, TILE_MAP, bundleTotal, emptyBundle } from '../src/shared/constants';
import {
  applyAction,
  buildableRoads,
  buildableVillages,
  createGame,
  currentPlayer,
  longestRoadLength,
  placeableVertices,
  placementOrder,
  placementPlayer,
  tradeRatios,
  victoryPoints,
  type GameState,
} from '../src/shared/rules';
import type { Bundle, GameAction } from '../src/shared/types';

const ids3 = ['p1', 'p2', 'p3'];
const noShuffle = () => 0.999999; // Fisher–Yates 에서 항상 자기 자리 → 순서 유지

/** 주사위가 a, b 로 나오게 하는 난수 */
function dice(a: number, b: number): () => number {
  const vals = [(a - 1) / 6 + 0.01, (b - 1) / 6 + 0.01];
  let i = 0;
  return () => vals[i++ % 2];
}

function act(s: GameState, p: string, a: GameAction, random: () => number = () => 0) {
  const r = applyAction(s, p, a, random);
  if (!r.ok) throw new Error(`${p} ${a.type}: ${r.message}`);
  return r;
}

function expectFail(s: GameState, p: string, a: GameAction, code?: string) {
  const before = JSON.stringify(s);
  const r = applyAction(s, p, a, () => 0);
  expect(r.ok).toBe(false);
  if (!r.ok && code) expect(r.code).toBe(code);
  // 거절된 요청은 상태를 바꾸지 않는다 (수락 실패로 제안이 닫히는 예외 제외)
  if (a.type !== 'trade_accept') expect(JSON.stringify(s)).toBe(before);
  return r;
}

function bundle(b: Partial<Bundle> = {}): Bundle {
  return { ...emptyBundle(), ...b };
}

/** 다섯 종류 모두 n개 */
function each(n: number, extra: Partial<Bundle> = {}): Bundle {
  const b = bundle();
  for (const r of RESOURCES) b[r] = n;
  return { ...b, ...extra };
}

const V = (...tiles: string[]) => vertexAt(...tiles);
const E = (a: string, b: string) => {
  const e = edgeBetween(a, b);
  if (!e) throw new Error(`${a}-${b} 사이 변 없음`);
  return e;
};

/**
 * 보드: 목재 B1 B3 C5 E1 / 곡물 A2 C1 C4 E2 / 양모 A1 B4 D2 E3 / 벽돌 B2 D1 D4 / 석재 A3 C2 D3 / 광장 C3
 * 시작 배치 (자리 순서 p1 → p2 → p3 → p3 → p2 → p1):
 *   p1: A1·B1·B2 (양모·목재·벽돌) + 길 → A1·B1,  C1·C2·D1 (곡물·석재·벽돌) + 길 → C1·D1
 *   p2: C4·D3·D4 (곡물·석재·벽돌) + 길 → C4·C5·D4,  A2·A3·B3 (곡물·석재·목재) + 길 → A3·B3·B4
 *   p3: D1·D2·E1 (벽돌·양모·목재) + 길 → D1·E1,  B3·B4·C4 (목재·양모·곡물) + 길 → B4·C4·C5
 */
const P1A = V('A1', 'B1', 'B2');
const P1B = V('C1', 'C2', 'D1');
const P2A = V('C4', 'D3', 'D4');
const P2B = V('A2', 'A3', 'B3');
const P3A = V('D1', 'D2', 'E1');
const P3B = V('B3', 'B4', 'C4');

function setup3(): GameState {
  const s = createGame(ids3, noShuffle);
  act(s, 'p1', { type: 'place', vertexId: P1A, edgeId: E(P1A, V('A1', 'B1')) });
  act(s, 'p2', { type: 'place', vertexId: P2A, edgeId: E(P2A, V('C4', 'C5', 'D4')) });
  act(s, 'p3', { type: 'place', vertexId: P3A, edgeId: E(P3A, V('D1', 'E1')) });
  act(s, 'p3', { type: 'place', vertexId: P3B, edgeId: E(P3B, V('B4', 'C4', 'C5')) });
  act(s, 'p2', { type: 'place', vertexId: P2B, edgeId: E(P2B, V('A3', 'B3', 'B4')) });
  act(s, 'p1', { type: 'place', vertexId: P1B, edgeId: E(P1B, V('C1', 'D1')) });
  return s;
}

/** p1 차례에 7이 아닌 숫자를 굴려 main 단계로 만든다 (아무 칸도 나오지 않는 숫자로 고정) */
function toMain(s: GameState, p = 'p1'): GameState {
  s.numbers = Object.fromEntries(Object.keys(s.numbers).map((k) => [k, 12]));
  act(s, p, { type: 'roll' }, dice(2, 3));
  expect(s.step).toBe('main');
  return s;
}

describe('보드: 꼭짓점·변·교역로·숫자', () => {
  it('19칸 보드에 꼭짓점 54개, 변 72개, 바닷가 변 30개', () => {
    expect(VERTICES).toHaveLength(54);
    expect(EDGES).toHaveLength(72);
    expect(coastEdges()).toHaveLength(30);
    for (const v of VERTICES) for (const n of v.neighbors) expect(VERTEX_MAP[n].neighbors).toContain(v.id);
    expect(new Set(VERTICES.map((v) => vertexLabel(v.id))).size).toBe(54);
    expect(new Set(EDGES.map((e) => edgeLabel(e.id))).size).toBe(72);
  });

  it('해상 교역로 9곳: 아무 자원 3:1 네 곳, 자원별 2:1 다섯 곳, 서로 꼭짓점을 나눠 갖지 않는다', () => {
    expect(HARBORS).toHaveLength(9);
    expect(HARBORS.filter((h) => h.resource === null)).toHaveLength(4);
    expect(new Set(HARBORS.filter((h) => h.resource).map((h) => h.resource)).size).toBe(5);
    const vs = HARBORS.flatMap(harborVertices);
    expect(new Set(vs).size).toBe(18);
    for (const h of HARBORS) expect(coastEdges()).toContain(h.edgeId);
  });

  it('숫자 토큰 18개가 생산 칸마다 하나씩, 광장에는 없고, 6과 8은 이웃하지 않는다', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 30; i++) {
      const nums = assignNumbers(rnd);
      expect(Object.keys(nums)).toHaveLength(18);
      expect(nums.C3).toBeUndefined();
      expect(Object.values(nums).sort((a, b) => a - b)).toEqual([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]);
      for (const [id, n] of Object.entries(nums)) {
        if (n !== 6 && n !== 8) continue;
        for (const nb of NEIGHBORS[id]) expect([6, 8], `${id}-${nb}`).not.toContain(nums[nb]);
      }
    }
  });

  it('19칸, 줄마다 3-4-5-4-3칸, 가운데 광장, 같은 종류 생산 칸끼리는 붙지 않는다', () => {
    const rows = ['A', 'B', 'C', 'D', 'E'].map((r) => TILES.filter((t) => t.id.startsWith(r)).length);
    expect(rows).toEqual([3, 4, 5, 4, 3]);
    expect(TILE_MAP.C3.kind).toBe('plaza');
    for (const [id, list] of Object.entries(NEIGHBORS)) {
      for (const n of list) if (TILE_MAP[id].kind !== 'plaza') expect(TILE_MAP[n].kind, `${id}-${n}`).not.toBe(TILE_MAP[id].kind);
    }
  });
});

describe('시작 배치', () => {
  it('자리 순서대로 한 바퀴, 거꾸로 한 바퀴. 기사단 동상은 광장에서 시작한다', () => {
    const s = createGame(ids3, noShuffle);
    expect(placementOrder(s)).toEqual(['p1', 'p2', 'p3', 'p3', 'p2', 'p1']);
    expect(placementPlayer(s)).toBe('p1');
    expect(s.robber).toBe('C3');
    expect(s.devDeck).toHaveLength(25);
    for (const id of ids3) expect(s.players[id].resources).toEqual(bundle());
  });

  it('두 번째 시작 마을은 닿은 생산 칸마다 자원 1장을 바로 받는다', () => {
    const s = setup3();
    expect(s.players.p1.resources).toEqual(bundle({ grain: 1, stone: 1, brick: 1 }));
    expect(s.players.p2.resources).toEqual(bundle({ grain: 1, stone: 1, wood: 1 }));
    expect(s.players.p3.resources).toEqual(bundle({ wood: 1, wool: 1, grain: 1 }));
    expect(s.phase).toBe('playing');
    expect(s.turn).toBe(1);
    expect(currentPlayer(s)).toBe('p1');
    expect(s.step).toBe('roll');
    for (const id of ids3) expect(victoryPoints(s, id)).toBe(2);
  });

  it('차례가 아니거나, 이웃 꼭짓점에 마을이 있거나, 길이 마을에 붙지 않으면 거절한다', () => {
    const s = createGame(ids3, noShuffle);
    const road = E(P1A, V('A1', 'B1'));
    expectFail(s, 'p2', { type: 'place', vertexId: P1A, edgeId: road }, 'NOT_YOUR_TURN');
    expectFail(s, 'p1', { type: 'place', vertexId: P1A, edgeId: E(V('C1', 'D1'), P1B) }, 'NOT_CONNECTED');
    act(s, 'p1', { type: 'place', vertexId: P1A, edgeId: road });
    const near = V('A1', 'A2', 'B2');
    expectFail(s, 'p2', { type: 'place', vertexId: near, edgeId: VERTEX_MAP[near].edges[0] }, 'TOO_CLOSE');
    expectFail(s, 'p2', { type: 'place', vertexId: P1A, edgeId: E(P1A, near) }, 'SPOT_TAKEN');
    expect(placeableVertices(s.buildings)).not.toContain(near);
    expectFail(s, 'p2', { type: 'roll' }, 'WRONG_PHASE');
  });
});

describe('주사위와 생산', () => {
  it('굴린 숫자의 칸에 닿은 마을은 1장, 도시는 2장을 받는다', () => {
    const s = setup3();
    s.numbers = Object.fromEntries(Object.keys(s.numbers).map((k) => [k, 12]));
    s.numbers.B1 = 5; // p1 의 A1·B1·B2 마을이 닿은 목재 칸
    s.numbers.C4 = 5; // p2·p3 가 닿은 곡물 칸
    s.buildings.find((b) => b.vertexId === P2A)!.kind = 'city';
    const before = { p1: { ...s.players.p1.resources }, p2: { ...s.players.p2.resources }, p3: { ...s.players.p3.resources } };
    act(s, 'p1', { type: 'roll' }, dice(2, 3));
    expect(s.dice).toEqual([2, 3]);
    expect(s.players.p1.resources.wood).toBe(before.p1.wood + 1);
    expect(s.players.p2.resources.grain).toBe(before.p2.grain + 2); // 도시
    expect(s.players.p3.resources.grain).toBe(before.p3.grain + 1);
    expect(s.step).toBe('main');
    expectFail(s, 'p1', { type: 'roll' }, 'WRONG_STEP');
  });

  it('기사단 동상이 선 칸은 숫자가 나와도 생산하지 않는다', () => {
    const s = setup3();
    s.numbers = Object.fromEntries(Object.keys(s.numbers).map((k) => [k, 12]));
    s.numbers.B1 = 5;
    s.robber = 'B1';
    const wood = s.players.p1.resources.wood;
    act(s, 'p1', { type: 'roll' }, dice(1, 4));
    expect(s.players.p1.resources.wood).toBe(wood);
    expect(s.events.at(-1)).toMatchObject({ kind: 'roll', blocked: ['B1'], tiles: [] });
  });

  it('7: 8장 이상이면 절반(내림)을 버리고, 동상을 옮기고, 닿은 사람 한 명에게서 1장을 빼앗는다', () => {
    const s = setup3();
    s.players.p2.resources = bundle({ wood: 5, stone: 4 }); // 9장 → 4장 버림
    s.players.p3.resources = bundle({ wool: 7 }); // 7장은 버리지 않음
    act(s, 'p1', { type: 'roll' }, dice(3, 4));
    expect(s.step).toBe('discard');
    expect(s.discards).toEqual({ p2: 4 });
    expectFail(s, 'p1', { type: 'end_turn' }, 'WRONG_STEP');
    expectFail(s, 'p2', { type: 'discard', bundle: bundle({ wood: 3 }) }, 'BAD_REQUEST');
    act(s, 'p2', { type: 'discard', bundle: bundle({ wood: 2, stone: 2 }) });
    expect(s.step).toBe('robber');
    expectFail(s, 'p1', { type: 'move_robber', tileId: 'C3' }, 'SPOT_INVALID'); // 같은 칸
    // C4 에는 p2(C4·D3·D4)·p3(B3·B4·C4)가 닿아 있어 고르는 단계가 된다
    act(s, 'p1', { type: 'move_robber', tileId: 'C4' });
    expect(s.step).toBe('steal');
    expect(s.stealFrom.sort()).toEqual(['p2', 'p3']);
    const before = bundleTotal(s.players.p1.resources);
    act(s, 'p1', { type: 'steal', from: 'p3' });
    expect(bundleTotal(s.players.p1.resources)).toBe(before + 1);
    expect(s.players.p1.resources.wool).toBe(1);
    expect(s.step).toBe('main');
  });

  it('동상을 옮긴 칸에 닿은 상대가 한 명이면 바로 빼앗고, 없으면 그냥 넘어간다', () => {
    const s = setup3();
    act(s, 'p1', { type: 'roll' }, dice(1, 6));
    expect(s.step).toBe('robber');
    act(s, 'p1', { type: 'move_robber', tileId: 'E3' }); // 아무도 닿지 않은 칸
    expect(s.step).toBe('main');
    expect(s.events.some((e) => e.kind === 'steal')).toBe(false);
  });
});

describe('턴', () => {
  it('주사위를 굴려야 행동하고, 턴을 넘기면 다음 자리로 간다', () => {
    const s = setup3();
    expectFail(s, 'p1', { type: 'end_turn' }, 'WRONG_STEP');
    expectFail(s, 'p1', { type: 'build_road', edgeId: E(P1A, V('A1', 'A2', 'B2')) }, 'WRONG_STEP');
    expectFail(s, 'p2', { type: 'roll' }, 'NOT_YOUR_TURN');
    toMain(s);
    act(s, 'p1', { type: 'end_turn' });
    expect(currentPlayer(s)).toBe('p2');
    expect(s.turn).toBe(2);
    expect(s.step).toBe('roll');
  });
});

describe('길·마을·도시', () => {
  it('길은 내 마을이나 내 길에 이어서만, 마을은 내 길 끝에 거리 규칙을 지켜서 짓는다. 행동 횟수 제한은 없다', () => {
    const s = toMain(setup3());
    s.players.p1.resources = each(5);
    const corner = V('A1', 'B1');
    const next = VERTEX_MAP[corner].neighbors.find((n) => n !== P1A && VERTEX_MAP[n].tiles.length === 1)!;
    expectFail(s, 'p1', { type: 'build_village', vertexId: next }, 'NOT_CONNECTED');
    expectFail(s, 'p1', { type: 'build_road', edgeId: E(V('D2', 'D3', 'E2'), V('D3', 'E2', 'E3')) }, 'NOT_CONNECTED');
    expectFail(s, 'p1', { type: 'build_village', vertexId: corner }, 'TOO_CLOSE');
    act(s, 'p1', { type: 'build_road', edgeId: E(corner, next) });
    expect(buildableVillages(s.buildings, s.roads, 'p1')).toContain(next);
    act(s, 'p1', { type: 'build_village', vertexId: next });
    act(s, 'p1', { type: 'build_road', edgeId: E(P1A, V('A1', 'A2', 'B2')) });
    expect(victoryPoints(s, 'p1')).toBe(3);
  });

  it('남의 마을이 선 꼭짓점을 지나서는 길을 잇지 못한다', () => {
    const s = setup3();
    s.roads.push({ edgeId: E(P1B, V('C2', 'D1', 'D2')), owner: 'p1', builtTurn: 0 });
    expect(buildableRoads(s.buildings, s.roads, 'p1')).toContain(E(V('C2', 'D1', 'D2'), P3A));
    s.roads.push({ edgeId: E(V('C2', 'D1', 'D2'), P3A), owner: 'p1', builtTurn: 0 });
    expect(buildableRoads(s.buildings, s.roads, 'p1')).not.toContain(E(P3A, V('D2', 'E1', 'E2')));
  });

  it('도시는 내 마을을 올려서만 짓는다 (곡물 2·석재 3). 마을 자리가 비면 마을을 다시 지을 수 있다', () => {
    const s = toMain(setup3());
    s.players.p1.resources = bundle({ grain: 2, stone: 3 });
    expectFail(s, 'p1', { type: 'build_city', vertexId: P2A }, 'SPOT_INVALID');
    expectFail(s, 'p1', { type: 'build_city', vertexId: V('A1', 'A2', 'B2') }, 'SPOT_INVALID');
    act(s, 'p1', { type: 'build_city', vertexId: P1A });
    expect(s.buildings.find((b) => b.vertexId === P1A)!.kind).toBe('city');
    expect(victoryPoints(s, 'p1')).toBe(3);
    expectFail(s, 'p1', { type: 'build_city', vertexId: P1A }, 'SPOT_INVALID');
  });

  it('비용이 부족하거나 한도를 넘으면 거절한다', () => {
    const s = toMain(setup3());
    const road = E(P1A, V('A1', 'A2', 'B2'));
    s.players.p1.resources = bundle({ wood: 1, grain: 3, stone: 3 });
    expectFail(s, 'p1', { type: 'build_road', edgeId: road }, 'NOT_ENOUGH');
    s.players.p1.resources = each(9);
    for (let i = 0; i < 13; i++) s.roads.push({ edgeId: `x${i}`, owner: 'p1', builtTurn: 0 });
    expectFail(s, 'p1', { type: 'build_road', edgeId: road }, 'LIMIT');
  });

  it('건설 비용은 카탄 설명서와 같다', () => {
    expect(PIECE_COST.road).toEqual(bundle({ wood: 1, brick: 1 }));
    expect(PIECE_COST.village).toEqual(bundle({ wood: 1, brick: 1, wool: 1, grain: 1 }));
    expect(PIECE_COST.city).toEqual(bundle({ grain: 2, stone: 3 }));
  });
});

describe('은행·해상 교역로 교환', () => {
  it('기본 4:1, 아무 자원 교역로 3:1, 정해진 자원 교역로 2:1', () => {
    const s = toMain(setup3());
    const special = HARBORS.find((h) => h.resource === 'wool')!;
    const generic = HARBORS.find((h) => h.resource === null)!;
    expect(tradeRatios(s, 'p1')).toEqual({ wood: 4, grain: 4, wool: 4, brick: 4, stone: 4 });
    s.buildings.push({ vertexId: harborVertices(generic)[0], owner: 'p1', kind: 'village', builtTurn: 0 });
    expect(tradeRatios(s, 'p1').wood).toBe(3);
    s.buildings.push({ vertexId: harborVertices(special)[1], owner: 'p1', kind: 'village', builtTurn: 0 });
    expect(tradeRatios(s, 'p1')).toMatchObject({ wool: 2, wood: 3 });
    s.players.p1.resources = bundle({ wool: 2, wood: 2 });
    expectFail(s, 'p1', { type: 'bank_trade', give: 'wood', get: 'stone' }, 'NOT_ENOUGH');
    act(s, 'p1', { type: 'bank_trade', give: 'wool', get: 'stone' });
    expect(s.players.p1.resources).toEqual(bundle({ wood: 2, stone: 1 }));
    expectFail(s, 'p1', { type: 'bank_trade', give: 'stone', get: 'stone' }, 'BAD_REQUEST');
  });
});

describe('발전 카드', () => {
  it('양모·곡물·석재로 사고, 산 턴에는 쓰지 못하며, 한 턴에 1장만 쓴다', () => {
    const s = toMain(setup3());
    s.players.p1.resources = bundle({ wool: 2, grain: 2, stone: 2 });
    s.devDeck = ['monopoly', 'knight'];
    act(s, 'p1', { type: 'buy_dev' });
    expect(s.players.p1.devCards).toEqual([{ kind: 'knight', boughtTurn: 1 }]);
    expectFail(s, 'p1', { type: 'play_dev', kind: 'knight' }, 'NOT_ALLOWED');
    act(s, 'p1', { type: 'buy_dev' });
    act(s, 'p1', { type: 'end_turn' });
    toMain(s, 'p2');
    act(s, 'p2', { type: 'end_turn' });
    toMain(s, 'p3');
    act(s, 'p3', { type: 'end_turn' });
    // p1 의 다음 턴: 굴리기 전에 기사를 쓰면 동상을 옮긴 뒤 다시 굴리기 단계로 돌아온다
    act(s, 'p1', { type: 'play_dev', kind: 'knight' });
    expect(s.step).toBe('robber');
    act(s, 'p1', { type: 'move_robber', tileId: 'E3' });
    expect(s.step).toBe('roll');
    expect(s.players.p1.knightsPlayed).toBe(1);
    toMain(s);
    expectFail(s, 'p1', { type: 'play_dev', kind: 'monopoly', resource: 'wood' }, 'NOT_ALLOWED');
  });

  it('독점: 다른 사람 모두의 그 자원을 가져온다. 풍년: 원하는 자원 2개. 길 건설: 공짜 길 2개', () => {
    const s = toMain(setup3());
    s.players.p1.devCards = [
      { kind: 'monopoly', boughtTurn: 0 },
      { kind: 'year_of_plenty', boughtTurn: 0 },
      { kind: 'road_building', boughtTurn: 0 },
    ];
    s.players.p2.resources = bundle({ wood: 3 });
    s.players.p3.resources = bundle({ wood: 2, wool: 1 });
    s.players.p1.resources = bundle();
    act(s, 'p1', { type: 'play_dev', kind: 'monopoly', resource: 'wood' });
    expect(s.players.p1.resources.wood).toBe(5);
    expect(s.players.p2.resources.wood + s.players.p3.resources.wood).toBe(0);
    s.devPlayedThisTurn = false;
    act(s, 'p1', { type: 'play_dev', kind: 'year_of_plenty', resources: ['stone', 'stone'] });
    expect(s.players.p1.resources.stone).toBe(2);
    s.devPlayedThisTurn = false;
    const roads = s.roads.length;
    act(s, 'p1', { type: 'play_dev', kind: 'road_building' });
    expect(s.step).toBe('road_building');
    const free = buildableRoads(s.buildings, s.roads, 'p1');
    act(s, 'p1', { type: 'build_road', edgeId: free[0] });
    act(s, 'p1', { type: 'build_road', edgeId: buildableRoads(s.buildings, s.roads, 'p1')[0] });
    expect(s.roads.length).toBe(roads + 2);
    expect(s.players.p1.resources.wood).toBe(5); // 공짜
    expect(s.step).toBe('main');
  });

  it('기사 3장을 가장 많이 쓴 사람이 최강 기사단(2점)을 갖고, 더 많이 쓴 사람에게 넘어간다', () => {
    const s = toMain(setup3());
    s.players.p1.knightsPlayed = 2;
    s.players.p1.devCards = [{ kind: 'knight', boughtTurn: 0 }];
    act(s, 'p1', { type: 'play_dev', kind: 'knight' });
    expect(s.largestArmy).toEqual({ holder: 'p1', size: 3 });
    expect(victoryPoints(s, 'p1')).toBe(4);
    expect(s.events.some((e) => e.kind === 'award' && e.award === 'largest_army' && e.player === 'p1')).toBe(true);
    act(s, 'p1', { type: 'move_robber', tileId: 'E3' });
    act(s, 'p1', { type: 'end_turn' });
    s.players.p2.knightsPlayed = 3;
    s.players.p2.devCards = [{ kind: 'knight', boughtTurn: 0 }];
    act(s, 'p2', { type: 'play_dev', kind: 'knight' });
    expect(s.largestArmy).toEqual({ holder: 'p2', size: 4 });
  });

  it('발전 카드 25장: 기사 14, 승점 5, 길 건설 2, 풍년 2, 독점 2', () => {
    expect(Object.values(DEV_DECK).reduce((a, b) => a + b, 0)).toBe(25);
    const s = createGame(ids3, noShuffle);
    const count = (k: string) => s.devDeck.filter((x) => x === k).length;
    expect([count('knight'), count('victory'), count('road_building'), count('year_of_plenty'), count('monopoly')]).toEqual([14, 5, 2, 2, 2]);
  });
});

describe('최장 교역로와 승리', () => {
  it('이어진 길 5칸 이상인 한 사람이 최장 교역로(2점)를 갖고, 남의 마을이 길을 끊는다', () => {
    const s = toMain(setup3());
    s.players.p1.resources = each(9);
    // P1A 에서 바닷가를 따라 길을 늘린다
    let at = V('A1', 'B1');
    let prev = P1A;
    for (let i = 0; i < 3; i++) {
      const next = VERTEX_MAP[at].neighbors.find((n) => n !== prev && !s.roads.some((r) => r.edgeId === E(at, n)))!;
      act(s, 'p1', { type: 'build_road', edgeId: E(at, next) });
      prev = at;
      at = next;
    }
    expect(longestRoadLength(s.roads, s.buildings, 'p1')).toBe(4);
    expect(s.longestRoad.holder).toBeNull();
    const next = VERTEX_MAP[at].neighbors.find((n) => n !== prev && !s.roads.some((r) => r.edgeId === E(at, n)))!;
    act(s, 'p1', { type: 'build_road', edgeId: E(at, next) });
    expect(longestRoadLength(s.roads, s.buildings, 'p1')).toBe(5);
    expect(s.longestRoad).toEqual({ holder: 'p1', length: 5 });
    expect(victoryPoints(s, 'p1')).toBe(4);
    // 길 가운데 꼭짓점에 남의 마을이 서면 끊긴다
    s.buildings.push({ vertexId: prev, owner: 'p2', kind: 'village', builtTurn: 1 });
    expect(longestRoadLength(s.roads, s.buildings, 'p1')).toBeLessThan(5);
  });

  it('자기 턴에 승점(숨긴 승점 카드 포함)이 10점에 닿으면 바로 이긴다', () => {
    const s = toMain(setup3());
    // 도시 1(2점) + 마을 2(2점) + 숨긴 승점 카드 5장 = 9점. 마을 하나를 도시로 올리면 10점.
    s.buildings.find((b) => b.vertexId === P1A)!.kind = 'city';
    s.buildings.push({ vertexId: V('D3', 'D4', 'E3'), owner: 'p1', kind: 'village', builtTurn: 1 });
    s.players.p1.devCards = Array.from({ length: 5 }, () => ({ kind: 'victory' as const, boughtTurn: 0 }));
    expect(victoryPoints(s, 'p1')).toBe(4);
    expect(victoryPoints(s, 'p1', true)).toBe(9);
    s.players.p1.resources = bundle({ grain: 2, stone: 3 });
    act(s, 'p1', { type: 'build_city', vertexId: P1B });
    expect(s.phase).toBe('finished');
    expect(s.result!.winners).toEqual(['p1']);
    expect(s.result!.ranking[0]).toMatchObject({ playerId: 'p1', score: 10, rank: 1 });
    expectFail(s, 'p1', { type: 'end_turn' }, 'WRONG_PHASE');
  });
});

describe('플레이어 교환', () => {
  it('제안 → 수락 시 양쪽 자원이 옮겨진다 (차례인 사람이 주사위를 굴린 뒤에만)', () => {
    const s = setup3();
    expectFail(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle({ brick: 1 }), get: bundle({ stone: 1 }) }, 'WRONG_STEP');
    toMain(s);
    act(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle({ brick: 1 }), get: bundle({ stone: 1 }) });
    const id = s.trade!.id;
    act(s, 'p2', { type: 'trade_accept', tradeId: id });
    expect(s.players.p1.resources).toEqual(bundle({ grain: 1, stone: 2 }));
    expect(s.players.p2.resources).toEqual(bundle({ grain: 1, wood: 1, brick: 1 }));
    expect(s.trade).toBeNull();
    const r = applyAction(s, 'p2', { type: 'trade_accept', tradeId: id });
    expect(r.ok).toBe(false);
  });

  it('양쪽 모두 자원을 내야 하고, 같은 종류를 양쪽에 둘 수 없다', () => {
    const s = toMain(setup3());
    expectFail(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle({ grain: 1 }), get: bundle() }, 'TRADE_INVALID');
    expectFail(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle({ grain: 1, stone: 1 }), get: bundle({ grain: 1 }) }, 'TRADE_INVALID');
    for (const to of ['p1', 'constructor', '__proto__', 'nobody']) {
      expectFail(s, 'p1', { type: 'trade_propose', to, give: bundle({ grain: 1 }), get: bundle({ wood: 1 }) }, 'TRADE_INVALID');
    }
    expectFail(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle({ wood: 5 }), get: bundle({ grain: 1 }) }, 'NOT_ENOUGH');
  });

  it('턴을 넘기면 제안이 닫힌다', () => {
    const s = toMain(setup3());
    act(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle({ grain: 1 }), get: bundle({ wood: 1 }) });
    const id = s.trade!.id;
    act(s, 'p1', { type: 'end_turn' });
    expect(s.trade).toBeNull();
    expect(applyAction(s, 'p2', { type: 'trade_accept', tradeId: id }).ok).toBe(false);
  });
});
