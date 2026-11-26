// 맵 모양(육각형·마름모·대형)과 땅 배치(황금 배치·섞기)
import { describe, expect, it } from 'vitest';
import { boardFor, boardOf, harborVertices, HARBORS, innerCoastEdges, STANDARD_BOARD, tileCenterUnit } from '../src/shared/board';
import { NUMBER_TOKENS, TILES, numberPips } from '../src/shared/constants';
import { DEFAULT_MAP, MAP_SHAPES, buildMap, goldenMap, mapCardDefaults, mapNumberTokens, maxPlayersFor, sameKindPairs, shuffledMap, type BuiltMap } from '../src/shared/maps';
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

/** 모양마다 광장 수와 교역로 수 (대형 맵은 광장 2칸, 가운데 바다 둘레 교역로 10곳) */
const PLAZAS: Record<MapShape, number> = { hex: 1, diamond: 1, big: 2, lakes: 1, islands: 2 };
const HARBOR_COUNT: Record<MapShape, number> = { hex: 9, diamond: 9, big: 10, lakes: 14, islands: 10 };
/** 3:1 교역로 수 (나머지는 자원마다 2:1) */
const GENERIC_HARBORS: Record<MapShape, number> = { hex: 4, diamond: 4, big: 5, lakes: 4, islands: 5 };
/** 방장이 직접 짠 맵: 그림 그대로라 황금 배치의 고르기 검사(같은 땅·숫자 맞닿음, 확률 고르기)는 하지 않는다 */
const DESIGNED: readonly MapShape[] = ['lakes'];

/**
 * 어느 배치에서나 지켜야 하는 것: 광장 수, 생산 칸마다 숫자 하나, 2~12 숫자가 모두 있음, 6·8 은 이웃하지 않음,
 * 교역로는 꼭짓점을 나눠 갖지 않음
 */
function expectPlayable(m: BuiltMap, shape: MapShape) {
  const plaza = m.tiles.filter((t) => t.kind === 'plaza');
  expect(plaza).toHaveLength(PLAZAS[shape]);
  expect(m.robber).toBe(plaza[0].id);
  expect([...new Set(Object.values(m.numbers))].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 8, 9, 10, 11, 12]);
  const prod = m.tiles.filter((t) => t.kind !== 'plaza');
  expect(Object.keys(m.numbers).sort()).toEqual(prod.map((t) => t.id).sort());
  expect(Object.values(m.numbers).sort((a, b) => a - b)).toEqual(mapNumberTokens(shape).sort((a, b) => a - b));
  for (const a of prod) for (const b of prod) if (a !== b && near(a, b)) expect(red(m.numbers[a.id]) && red(m.numbers[b.id])).toBe(false);
  const board = boardFor(m.tiles);
  const harbors = HARBOR_COUNT[shape];
  expect(m.harbors).toHaveLength(harbors);
  const vs = m.harbors.flatMap((h) => harborVertices(board, h));
  expect(vs.every((v) => board.vertexMap[v])).toBe(true);
  expect(new Set(vs).size).toBe(harbors * 2);
  expect(m.harbors.every((h) => board.edgeMap[h.edgeId].tiles.length === 1)).toBe(true);
  expect(m.harbors.filter((h) => h.resource === null)).toHaveLength(GENERIC_HARBORS[shape]);
  // 다섯 자원마다 2:1 교역로가 같은 수만큼 있다
  const special = m.harbors.filter((h) => h.resource !== null).map((h) => h.resource!);
  for (const r of ['brick', 'grain', 'stone', 'wood', 'wool'] as Resource[]) expect(special.filter((x) => x === r)).toHaveLength(special.length / 5);
}

describe('황금 배치', () => {
  it('육각형 황금 배치의 땅과 교역로는 예전 고정 보드와 같다 (꼭짓점·변 ID 도 그대로)', () => {
    const m = goldenMap('hex');
    expect(m.tiles).toEqual(TILES);
    expect(boardFor(m.tiles)).toBe(STANDARD_BOARD);
    expect(m.harbors).toEqual(HARBORS);
    expect(Object.values(m.numbers).sort((a, b) => a - b)).toEqual([...NUMBER_TOKENS].sort((a, b) => a - b));
  });

  it.each(MAP_SHAPES.filter((s) => !DESIGNED.includes(s)))('%s: 같은 땅끼리 맞닿지 않고, 같은 숫자도 이웃하지 않으며, 자원마다 나올 확률이 고르다', (shape) => {
    const m = goldenMap(shape);
    expectPlayable(m, shape);
    expect(sameKindPairs(m.tiles)).toBe(0);
    const prod = m.tiles.filter((t) => t.kind !== 'plaza');
    for (const a of prod) for (const b of prod) if (a !== b && near(a, b)) expect(m.numbers[a.id]).not.toBe(m.numbers[b.id]);
    // 자원별 점(나올 경우의 수)이 칸 수에 비례한 몫에서 2점 넘게 벗어나지 않는다
    const total = prod.reduce((n, t) => n + numberPips(m.numbers[t.id]), 0);
    const reds = prod.filter((t) => red(m.numbers[t.id])).length;
    for (const r of ['wood', 'grain', 'wool', 'brick', 'stone'] as Resource[]) {
      const tiles = prod.filter((t) => t.kind === r);
      const pips = tiles.reduce((n, t) => n + numberPips(m.numbers[t.id]), 0);
      expect(Math.abs(pips - (total * tiles.length) / prod.length)).toBeLessThanOrEqual(2);
      // 빨간 숫자(6·8)는 한 자원에 몰리지 않는다
      expect(tiles.filter((t) => red(m.numbers[t.id])).length).toBeLessThanOrEqual(Math.ceil(reds / 5));
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

describe('대형 맵', () => {
  it('반지름 4칸 정육각형에서 가운데 19칸이 바다인 42칸이고, 교역로 10곳은 모두 가운데 바다 둘레에 있다', () => {
    const m = goldenMap('big');
    expect(m.tiles).toHaveLength(42);
    const board = boardFor(m.tiles);
    expect(board.vertices).toHaveLength(126);
    // 가운데(0,0)에서 두 칸 안은 바다라 칸이 없고, 바깥 끝은 네 칸 떨어져 있다
    const d = (t: TileDef) => (Math.abs(t.q) + Math.abs(t.r) + Math.abs(t.q + t.r)) / 2;
    expect(m.tiles.every((t) => d(t) === 3 || d(t) === 4)).toBe(true);
    const inner = innerCoastEdges(board);
    expect(inner).toHaveLength(30);
    expect(m.harbors.every((h) => inner.includes(h.edgeId))).toBe(true);
    // 광장에 붙은 교역로는 없다
    expect(m.harbors.every((h) => board.edgeMap[h.edgeId].tiles.every((t) => board.tileMap[t].kind !== 'plaza'))).toBe(true);
    // 숫자 패 40개: 2~12 가 모두 있고 2·12 는 두 개씩
    expect(mapNumberTokens('big')).toHaveLength(40);
    expect(mapNumberTokens('big').filter((n) => n === 2 || n === 12)).toHaveLength(4);
    // 가운데 바다가 없는 맵은 안쪽 바닷가도 없다
    expect(innerCoastEdges(STANDARD_BOARD)).toEqual([]);
    expect(innerCoastEdges(boardFor(goldenMap('diamond').tiles))).toEqual([]);
  });

  it('8명까지 함께 하고, 시작 배치부터 여러 턴을 자동으로 진행해도 판 밖의 자리를 쓰지 않는다', () => {
    expect(maxPlayersFor('hex')).toBe(4);
    expect(maxPlayersFor('diamond')).toBe(4);
    expect(maxPlayersFor('big')).toBe(8);
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(() => createGame([...ids, 'i'], seeded(1), { map: { shape: 'big', arrange: 'golden' } })).toThrow();
    expect(() => createGame(ids.slice(0, 5), seeded(1), { map: { shape: 'hex', arrange: 'golden' } })).toThrow();
    const random = seeded(5);
    const s = createGame(ids, random, { map: { shape: 'big', arrange: 'shuffle' } });
    // 은행과 발전 카드도 사람 수에 맞춰 늘어난다
    expect(s.bank?.wood).toBe(mapCardDefaults('big').resourceCards);
    expect(s.devDeck).toHaveLength(mapCardDefaults('big').devCards);
    const board = boardOf(s);
    for (let i = 0; i < 1200 && s.phase !== 'finished'; i++) autoPlay(s, random);
    expect(s.turn).toBeGreaterThan(30);
    expect(s.buildings.length).toBeGreaterThanOrEqual(16);
    expect(s.buildings.every((b) => board.vertexMap[b.vertexId])).toBe(true);
    expect(s.roads.every((r) => board.edgeMap[r.edgeId])).toBe(true);
    expect(new Set(s.buildings.map((b) => b.owner)).size).toBe(8);
  });

  it('대기실: 대형 맵이면 8명까지 들어오고, 5명 넘게 있으면 보통 맵으로 바꿀 수 없다', () => {
    const m = new RoomManager();
    const made = m.create('방장');
    if ('error' in made) throw new Error(made.error);
    const { room, player } = made;
    for (let i = 1; i < 4; i++) if ('error' in m.join(room.code, '손님' + i)) throw new Error('join');
    const fifth = m.join(room.code, '손님4');
    expect('error' in fifth && fifth.code).toBe('FULL');
    expect(m.peek(room.code)!.maxPlayers).toBe(4);
    // 대형 맵을 고르면 카드 장수도 대형 맵 기본값으로 바뀐다
    expect(m.setSettings(room, player.id, { mapShape: 'big' })).toBeNull();
    expect(room.resourceCards).toBe(mapCardDefaults('big').resourceCards);
    expect(room.devCards).toBe(mapCardDefaults('big').devCards);
    expect(m.peek(room.code)!.maxPlayers).toBe(8);
    for (let i = 4; i < 8; i++) if ('error' in m.join(room.code, '손님' + i)) throw new Error('join');
    const ninth = m.join(room.code, '손님8');
    expect('error' in ninth && ninth.code).toBe('FULL');
    expect(m.setSettings(room, player.id, { mapShape: 'hex' })).not.toBeNull();
    expect(room.map.shape).toBe('big');
    for (const p of room.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(room, player.id)).toBeNull();
    expect(room.game!.order).toHaveLength(8);
    expect(new Set(room.players.map((p) => p.colorIndex)).size).toBe(8);
    m.stopAllClocks();
  });

  it('직접 바꾼 카드 장수는 맵을 바꿔도 그대로 둔다', () => {
    const m = new RoomManager();
    const made = m.create('방장');
    if ('error' in made) throw new Error(made.error);
    const { room, player } = made;
    expect(m.setSettings(room, player.id, { resourceCards: 25 })).toBeNull();
    expect(m.setSettings(room, player.id, { mapShape: 'big' })).toBeNull();
    expect(room.resourceCards).toBe(25);
    expect(room.devCards).toBe(mapCardDefaults('big').devCards);
    expect(m.setSettings(room, player.id, { mapShape: 'hex' })).toBeNull();
    expect(room.resourceCards).toBe(25);
    expect(room.devCards).toBe(mapCardDefaults('hex').devCards);
  });
});

describe('호수 맵', () => {
  it('보내 준 그림 그대로: 43칸, 가운데 사막, 두 칸짜리 호수 네 곳, 교역로 14곳(호수 안 네 곳)', () => {
    const m = goldenMap('lakes');
    expectPlayable(m, 'lakes');
    expect(m.tiles).toHaveLength(43);
    const center = m.tiles.find((t) => t.q === 0 && t.r === 0)!;
    expect(center.kind).toBe('plaza');
    expect(m.robber).toBe(center.id);
    const board = boardFor(m.tiles);
    // 호수는 바깥 바다와 이어지지 않은 물 네 곳이고, 교역로 네 곳이 그 둘레에 있다
    const inner = innerCoastEdges(board);
    expect(m.harbors.filter((h) => inner.includes(h.edgeId))).toHaveLength(4);
    const kinds = (k: string) => m.tiles.filter((t) => t.kind === k).length;
    expect([kinds('wood'), kinds('wool'), kinds('stone'), kinds('brick'), kinds('grain')]).toEqual([9, 9, 9, 8, 7]);
    // 그림의 숫자: 가운데 사막 오른쪽 목재 4, 맨 위 왼쪽 벽돌 5, 맨 아래 왼쪽 양모 12
    const at = (q: number, r: number) => m.tiles.find((t) => t.q === q && t.r === r)!;
    expect([at(1, 0).kind, m.numbers[at(1, 0).id]]).toEqual(['wood', 4]);
    expect([at(0, -4).kind, m.numbers[at(0, -4).id]]).toEqual(['brick', 5]);
    expect([at(-4, 4).kind, m.numbers[at(-4, 4).id]]).toEqual(['wool', 12]);
    expect(maxPlayersFor('lakes')).toBe(8);
  });

  it('섞어도 칸 자리와 교역로 자리는 그대로이고 같은 땅이 맞닿지 않는다', () => {
    const golden = goldenMap('lakes');
    for (let seed = 1; seed <= 10; seed++) {
      const m = shuffledMap('lakes', seeded(seed));
      expectPlayable(m, 'lakes');
      expect(sameKindPairs(m.tiles)).toBe(0);
      expect(m.harbors.map((h) => h.edgeId)).toEqual(golden.harbors.map((h) => h.edgeId));
    }
  });
});

describe('개수 제한 없음', () => {
  it('길·마을·도시를 제한보다 많이 지을 수 있고 발전 카드는 사도 줄지 않는다', () => {
    const s = createGame(['a', 'b'], seeded(2), { unlimited: true, devCards: 10 });
    const t = createGame(['a', 'b'], seeded(2), { devCards: 10 });
    expect(s.unlimited).toBe(true);
    expect(t.unlimited).toBe(false);
    for (const g of [s, t]) {
      // 시작 배치를 건너뛰고 a 의 차례 교환·건설 단계로 둔다
      g.phase = 'playing';
      g.turn = 1;
      g.current = g.order.indexOf('a');
      g.step = 'main';
      g.bank = null;
      g.players.a.resources = { wood: 99, grain: 99, wool: 99, brick: 99, stone: 99 };
      // 승점 카드로 게임이 끝나지 않게 승리 점수를 높여 둔다
      g.winPoints = 99;
    }
    // 서로 떨어진 꼭짓점에 마을 여섯 채를 세운다 (제한 5)
    const board = boardOf(s);
    const spots: string[] = [];
    for (const v of board.vertices) {
      if (spots.length >= 6) break;
      if (spots.every((x) => x !== v.id && !board.vertexMap[x].neighbors.includes(v.id))) spots.push(v.id);
    }
    for (const g of [s, t]) {
      g.buildings = spots.slice(0, 5).map((vertexId) => ({ vertexId, owner: 'a', kind: 'village' as const, builtTurn: 0 }));
      // 여섯 번째 자리에 길을 이어 둔다
      const e = board.vertexMap[spots[5]].edges[0];
      g.roads = [{ edgeId: e, owner: 'a', builtTurn: 0 }];
    }
    expect(applyAction(t, 'a', { type: 'build_village', vertexId: spots[5] })).toMatchObject({ ok: false, code: 'LIMIT' });
    expect(applyAction(s, 'a', { type: 'build_village', vertexId: spots[5] })).toEqual({ ok: true });
    expect(s.buildings.filter((b) => b.owner === 'a' && b.kind === 'village')).toHaveLength(6);
    // 발전 카드: 제한 있음은 10장을 사면 떨어지고, 제한 없음은 그보다 많이 사도 더미가 그대로다
    for (let i = 0; i < 10; i++) expect(applyAction(t, 'a', { type: 'buy_dev' })).toEqual({ ok: true });
    expect(applyAction(t, 'a', { type: 'buy_dev' })).toMatchObject({ ok: false, code: 'NO_CARD' });
    const deck = [...s.devDeck];
    for (let i = 0; i < 15; i++) expect(applyAction(s, 'a', { type: 'buy_dev' })).toEqual({ ok: true });
    expect(s.devDeck).toEqual(deck);
    expect(s.players.a.devCards).toHaveLength(15);
  });

  it('방장이 대기실에서 고르고, 저장했다 되살려도 그대로다 (예전 저장은 제한 있음)', () => {
    const m = new RoomManager();
    const made = m.create('방장');
    if ('error' in made) throw new Error(made.error);
    const { room, player } = made;
    expect(room.unlimited).toBe(false);
    expect(m.setSettings(room, player.id, { unlimited: 'yes' as never })).not.toBeNull();
    expect(m.setSettings(room, player.id, { unlimited: true })).toBeNull();
    const joined = m.join(room.code, '손님');
    if ('error' in joined) throw new Error(joined.error);
    for (const p of room.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(room, player.id)).toBeNull();
    expect(room.game!.unlimited).toBe(true);
    m.stopAllClocks();
    const data = JSON.parse(snapshotRooms(m.rooms.values()));
    expect(restoreRooms(JSON.stringify(data)).rooms[0].game!.unlimited).toBe(true);
    delete data.rooms[0].unlimited;
    delete data.rooms[0].game.unlimited;
    const back = restoreRooms(JSON.stringify(data)).rooms[0];
    expect(back.unlimited).toBe(false);
    expect(back.game!.unlimited).toBe(false);
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
