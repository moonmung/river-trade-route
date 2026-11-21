// 맵 모양(육각형·마름모)과 땅 배치(황금 배치·섞기)
import { describe, expect, it } from 'vitest';
import { boardFor, boardOf, harborVertices, HARBORS, STANDARD_BOARD, tileCenterUnit } from '../src/shared/board';
import { NUMBER_TOKENS, TILES, numberPips } from '../src/shared/constants';
import { DEFAULT_MAP, MAP_SHAPES, buildMap, goldenMap, mapNumberTokens, sameKindPairs, shuffledMap, type BuiltMap } from '../src/shared/maps';
import { applyAction, autoPlay, createGame, placeableVertices, productionFor } from '../src/shared/rules';
import { parseAction } from '../src/shared/validate';
import { RoomManager } from '../src/server/rooms';
import { restoreRooms, snapshotRooms } from '../src/server/persist';
import type { MapShape, Resource, TileDef } from '../src/shared/types';

/** 고정 시드 난수 (테스트마다 같은 판이 나온다) */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const near = (a: TileDef, b: TileDef) => {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 === 1;
};
const red = (n: number | undefined) => n === 6 || n === 8;

/** 어느 배치에서나 지켜야 하는 것: 광장 1칸, 생산 칸마다 숫자 하나, 6·8 은 이웃하지 않음, 교역로 9곳은 꼭짓점을 나눠 갖지 않음 */
function expectPlayable(m: BuiltMap, shape: MapShape) {
  const plaza = m.tiles.filter((t) => t.kind === 'plaza');
  expect(plaza).toHaveLength(1);
  expect(m.robber).toBe(plaza[0].id);
  const prod = m.tiles.filter((t) => t.kind !== 'plaza');
  expect(Object.keys(m.numbers).sort()).toEqual(prod.map((t) => t.id).sort());
  expect(Object.values(m.numbers).sort((a, b) => a - b)).toEqual(mapNumberTokens(shape).sort((a, b) => a - b));
  for (const a of prod) for (const b of prod) if (a !== b && near(a, b)) expect(red(m.numbers[a.id]) && red(m.numbers[b.id])).toBe(false);
  const board = boardFor(m.tiles);
  expect(m.harbors).toHaveLength(9);
  const vs = m.harbors.flatMap((h) => harborVertices(board, h));
  expect(vs.every((v) => board.vertexMap[v])).toBe(true);
  expect(new Set(vs).size).toBe(18);
  expect(m.harbors.every((h) => board.edgeMap[h.edgeId].tiles.length === 1)).toBe(true);
  expect(m.harbors.filter((h) => h.resource === null)).toHaveLength(4);
}

describe('황금 배치', () => {
  it('육각형 황금 배치의 땅과 교역로는 예전 고정 보드와 같다 (꼭짓점·변 ID 도 그대로)', () => {
    const m = goldenMap('hex');
    expect(m.tiles).toEqual(TILES);
    expect(boardFor(m.tiles)).toBe(STANDARD_BOARD);
    expect(m.harbors).toEqual(HARBORS);
    expect(Object.values(m.numbers).sort((a, b) => a - b)).toEqual([...NUMBER_TOKENS].sort((a, b) => a - b));
  });

  it.each(MAP_SHAPES)('%s: 같은 땅끼리 맞닿지 않고, 같은 숫자도 이웃하지 않으며, 자원마다 나올 확률이 고르다', (shape) => {
    const m = goldenMap(shape);
    expectPlayable(m, shape);
    expect(sameKindPairs(m.tiles)).toBe(0);
    const prod = m.tiles.filter((t) => t.kind !== 'plaza');
    for (const a of prod) for (const b of prod) if (a !== b && near(a, b)) expect(m.numbers[a.id]).not.toBe(m.numbers[b.id]);
    // 자원별 점(나올 경우의 수)이 칸 수에 비례한 몫에서 2점 넘게 벗어나지 않는다
    const total = prod.reduce((n, t) => n + numberPips(m.numbers[t.id]), 0);
    for (const r of ['wood', 'grain', 'wool', 'brick', 'stone'] as Resource[]) {
      const tiles = prod.filter((t) => t.kind === r);
      const pips = tiles.reduce((n, t) => n + numberPips(m.numbers[t.id]), 0);
      expect(Math.abs(pips - (total * tiles.length) / prod.length)).toBeLessThanOrEqual(2);
      // 빨간 숫자(6·8)는 한 자원에 몰리지 않는다
      expect(tiles.filter((t) => red(m.numbers[t.id])).length).toBeLessThanOrEqual(1);
    }
    // 한 꼭짓점에 몰리는 점은 11점까지
    const board = boardFor(m.tiles);
    for (const v of board.vertices) expect(v.tiles.reduce((n, t) => n + (m.numbers[t] ? numberPips(m.numbers[t]) : 0), 0)).toBeLessThanOrEqual(11);
  });

  it('마름모는 4칸씩 4줄 16칸이고, 아래 줄로 갈수록 오른쪽으로 밀려 윗부분이 왼쪽으로 기운다', () => {
    const m = goldenMap('diamond');
    expect(m.tiles).toHaveLength(16);
    const board = boardFor(m.tiles);
    expect(board.vertices).toHaveLength(48);
    expect(board.edges.filter((e) => e.tiles.length === 1)).toHaveLength(30);
    const rowX = [0, 1, 2, 3].map((row) => tileCenterUnit(m.tiles.find((t) => t.row === row && t.col === 0)!).x);
    for (let i = 1; i < rowX.length; i++) expect(rowX[i]).toBeGreaterThan(rowX[i - 1]);
    // 다섯 자원이 3칸씩
    for (const r of ['wood', 'grain', 'wool', 'brick', 'stone']) expect(m.tiles.filter((t) => t.kind === r)).toHaveLength(3);
  });
});

describe('섞기', () => {
  it.each(MAP_SHAPES)('%s: 여러 시드로 섞어도 광장 자리와 땅 구성은 그대로이고 규칙을 지킨다', (shape) => {
    const golden = goldenMap(shape);
    const count = (tiles: TileDef[]) => tiles.map((t) => t.kind).sort();
    const layouts = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const m = shuffledMap(shape, seeded(seed));
      expectPlayable(m, shape);
      expect(count(m.tiles)).toEqual(count(golden.tiles));
      expect(m.robber).toBe(golden.robber);
      expect(m.tiles.map((t) => [t.id, t.q, t.r])).toEqual(golden.tiles.map((t) => [t.id, t.q, t.r]));
      expect(sameKindPairs(m.tiles)).toBe(0);
      layouts.add(m.tiles.map((t) => t.kind).join());
    }
    // 섞기는 매번 다른 판을 만든다
    expect(layouts.size).toBeGreaterThan(30);
  });

  it('게임마다 섞인 판을 게임 상태에 싣고, 규칙은 그 판으로 생산을 계산한다', () => {
    const s = createGame(['a', 'b'], seeded(7), { map: { shape: 'diamond', arrange: 'shuffle' } });
    expect(s.tiles).toHaveLength(16);
    const board = boardOf(s);
    const v = board.vertices.find((x) => x.tiles.length === 3 && x.tiles.every((t) => board.tileMap[t].kind !== 'plaza'))!;
    s.buildings.push({ vertexId: v.id, owner: 'a', kind: 'city', builtTurn: 0 });
    const t = v.tiles[0];
    s.robber = s.tiles.find((x) => x.kind === 'plaza')!.id;
    const { gains, tiles } = productionFor(s, s.numbers[t], ['a', 'b']);
    expect(tiles).toContain(t);
    expect(gains.a[board.tileMap[t].kind as Resource]).toBeGreaterThanOrEqual(2);
  });
});

describe('마름모 맵으로 게임하기', () => {
  it('시작 배치부터 여러 턴을 자동으로 진행해도 마름모 보드 밖의 자리를 쓰지 않는다', () => {
    const random = seeded(3);
    const s = createGame(['a', 'b', 'c'], random, { map: { shape: 'diamond', arrange: 'golden' } });
    const board = boardOf(s);
    for (let i = 0; i < 400 && s.phase !== 'finished'; i++) autoPlay(s, random);
    expect(s.phase).toBe('playing');
    expect(s.turn).toBeGreaterThan(20);
    expect(s.buildings.length).toBeGreaterThanOrEqual(6);
    expect(s.buildings.every((b) => board.vertexMap[b.vertexId])).toBe(true);
    expect(s.roads.every((r) => board.edgeMap[r.edgeId])).toBe(true);
    expect(board.tileMap[s.robber]).toBeDefined();
  });

  it('줄마다 4칸이라 육각형에는 없는 칸 코드(A4)도 받고, 그 판에 없는 칸은 거절한다', () => {
    expect(parseAction({ type: 'move_robber', tileId: 'A4' })).toEqual({ type: 'move_robber', tileId: 'A4' });
    expect(parseAction({ type: 'move_robber', tileId: 'a4' })).toBeNull();
    expect(parseAction({ type: 'place_village', vertexId: 'v0' })).toBeNull();
    const s = createGame(['a', 'b'], () => 0.999999, { map: { shape: 'diamond', arrange: 'golden' } });
    // 마름모 판의 꼭짓점은 48개라 v49 는 없다
    expect(applyAction(s, s.order[0], { type: 'place_village', vertexId: 'v49' }).ok).toBe(false);
    expect(placeableVertices(boardOf(s), s.buildings)).toHaveLength(48);
  });
});

describe('방장이 고르는 맵', () => {
  it('기본은 육각형 황금 배치이고, 방장이 고른 모양과 배치로 게임을 연다', () => {
    const m = new RoomManager();
    const made = m.create('방장');
    if ('error' in made) throw new Error(made.error);
    const { room, player } = made;
    expect(room.map).toEqual(DEFAULT_MAP);
    expect(m.setSettings(room, player.id, { mapShape: 'square' as MapShape })).not.toBeNull();
    expect(m.setSettings(room, player.id, { mapShape: 'diamond', mapArrange: 'random' as never })).not.toBeNull();
    expect(room.map).toEqual(DEFAULT_MAP);
    expect(m.setSettings(room, player.id, { mapShape: 'diamond', mapArrange: 'shuffle' })).toBeNull();
    expect(room.map).toEqual({ shape: 'diamond', arrange: 'shuffle' });
    const joined = m.join(room.code, '손님');
    if ('error' in joined) throw new Error(joined.error);
    for (const p of room.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(room, player.id)).toBeNull();
    expect(room.game!.tiles).toHaveLength(16);
    m.stopAllClocks();
  });

  it('맵을 고르기 전에 저장한 방과 게임은 표준 육각 보드로 되살린다', () => {
    const m = new RoomManager();
    const made = m.create('방장');
    if ('error' in made) throw new Error(made.error);
    const joined = m.join(made.room.code, '손님');
    if ('error' in joined) throw new Error(joined.error);
    const room = made.room;
    for (const p of room.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(room, made.player.id)).toBeNull();
    m.stopAllClocks();
    const data = JSON.parse(snapshotRooms(m.rooms.values()));
    delete data.rooms[0].map;
    delete data.rooms[0].game.tiles;
    const back = restoreRooms(JSON.stringify(data)).rooms[0];
    expect(back.map).toEqual(DEFAULT_MAP);
    expect(back.game!.tiles).toEqual(TILES);
  });

  it('buildMap 은 배치 설정에 따라 황금 배치나 섞기를 고른다', () => {
    expect(buildMap({ shape: 'hex', arrange: 'golden' }, seeded(1))).toEqual(goldenMap('hex'));
    expect(buildMap({ shape: 'diamond', arrange: 'shuffle' }, seeded(9))).toEqual(shuffledMap('diamond', seeded(9)));
  });
});
