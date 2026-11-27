// 섬 맵의 항해사 규칙: 큰 섬 시작·시작 배, 새 섬 보너스, 해적선, 금광
import { describe, expect, it } from 'vitest';
import { boardOf, smallIslandAt } from '../src/shared/board';
import { ISLAND_BONUS_POINTS, ISLANDS_WIN_POINTS, WIN_POINTS } from '../src/shared/constants';
import { buildGameView } from '../src/shared/gameView';
import { goldenMap, mapWinPoints, shuffledMap } from '../src/shared/maps';
import {
  applyAction,
  autoPlay,
  buildableShips,
  createGame,
  pirateTargets,
  placeableVertices,
  placementPlayer,
  setupShipEdges,
  shipMoveProblem,
  victoryPoints,
  type GameState,
} from '../src/shared/rules';
import { parseAction } from '../src/shared/validate';
import { RoomManager } from '../src/server/rooms';
import type { GameAction } from '../src/shared/types';

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

/** 주사위가 a, b 로 나오게 하는 난수 */
function dice(a: number, b: number): () => number {
  const vals = [(a - 1) / 6 + 0.01, (b - 1) / 6 + 0.01];
  let i = 0;
  return () => vals[i++ % 2];
}

function act(s: GameState, p: string, a: GameAction, random: () => number = () => 0) {
  const r = applyAction(s, p, a, random);
  if (!r.ok) throw new Error(`${p} ${a.type}: ${r.message}`);
}

function fail(s: GameState, p: string, a: GameAction, code: string) {
  const before = JSON.stringify(s);
  const r = applyAction(s, p, a, () => 0);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe(code);
  expect(JSON.stringify(s)).toBe(before);
  return r;
}

/** 섬 맵 a·b 두 사람 게임을 a 의 차례 교환·건설 단계로 둔다 (시작 배치 없음, 자원 넉넉히) */
function islandGame(): GameState {
  const s = createGame(['a', 'b'], seeded(4), { map: { shape: 'islands', arrange: 'golden' }, rollForOrder: false });
  s.order = ['a', 'b'];
  s.phase = 'playing';
  s.turn = 1;
  s.current = 0;
  s.step = 'main';
  s.winPoints = 20;
  for (const id of s.order) s.players[id].resources = { wood: 10, grain: 10, wool: 10, brick: 10, stone: 10 };
  return s;
}


describe('시작 배치 (섬 맵)', () => {
  it('시작 마을은 큰 섬에만 짓고, 바닷가 시작 마을에는 길 대신 배를 붙여 띄운다', () => {
    const s = createGame(['a', 'b'], seeded(2), { map: { shape: 'islands', arrange: 'golden' }, rollForOrder: false });
    const board = boardOf(s);
    const spots = placeableVertices(board, s.buildings);
    expect(spots.length).toBeGreaterThan(20);
    expect(spots.every((v) => smallIslandAt(board, v) === null)).toBe(true);
    const p = placementPlayer(s)!;
    // 작은 섬 꼭짓점은 거절한다
    const small = board.vertices.find((v) => smallIslandAt(board, v.id) !== null)!;
    fail(s, p, { type: 'place_village', vertexId: small.id }, 'SPOT_INVALID');
    // 큰 섬 바닷가 꼭짓점에 마을을 짓고 바닷길에 배를 붙인다
    const coast = spots.find((v) => board.vertexMap[v].tiles.length === 1)!;
    act(s, p, { type: 'place_village', vertexId: coast });
    const ships = setupShipEdges(board, s.roads, s.ships, coast, s.pirate);
    expect(ships.length).toBeGreaterThan(0);
    const far = board.sea!.edges.find((e) => e.a !== coast && e.b !== coast)!;
    fail(s, p, { type: 'place_ship', edgeId: far.id }, 'NOT_CONNECTED');
    act(s, p, { type: 'place_ship', edgeId: ships[0] });
    expect(s.ships).toEqual([{ edgeId: ships[0], owner: p, builtTurn: 0 }]);
    expect(s.roads).toEqual([]);
    expect(s.events.at(-1)).toMatchObject({ kind: 'placement', step: 'road', ship: true });
    // 다음 사람 차례로 넘어갔다
    expect(placementPlayer(s)).not.toBe(p);
    expect(s.setupVillage).toBeNull();
  });

  it('배가 없는 맵에서는 시작 배를 띄우지 못하고 작은 섬 제한도 없다', () => {
    const s = createGame(['a', 'b'], seeded(2), { rollForOrder: false });
    const p = placementPlayer(s)!;
    const v = placeableVertices(boardOf(s), s.buildings)[0];
    act(s, p, { type: 'place_village', vertexId: v });
    fail(s, p, { type: 'place_ship', edgeId: boardOf(s).vertexMap[v].edges[0] }, 'NOT_ALLOWED');
    expect(placeableVertices(boardOf(createGame(['a', 'b'], seeded(2))), [])).toHaveLength(54);
  });
});

describe('새 섬 보너스', () => {
  it('작은 섬에 처음 마을을 지으면 섬마다 2점, 같은 섬의 두 번째 마을은 없고 다른 사람도 따로 받는다', () => {
    const s = islandGame();
    const board = boardOf(s);
    // 작은 섬(3칸) 하나의 서로 떨어진 바닷가 꼭짓점 둘에 배를 대어 둔다
    const island = board.islandSizes.findIndex((n) => n <= 3);
    const verts = board.vertices.filter((v) => v.tiles.length === 1 && board.islandOf[v.tiles[0]] === island);
    const v1 = verts[0].id;
    expect(smallIslandAt(board, v1)).toBe(island);
    const v2 = verts.find((v) => v.id !== v1 && !board.vertexMap[v1].neighbors.includes(v.id))!.id;
    const seaEdge = (v: string) => board.sea!.vertexMap[v].edges[0];
    s.ships.push({ edgeId: seaEdge(v1), owner: 'a', builtTurn: 0 }, { edgeId: seaEdge(v2), owner: 'b', builtTurn: 0 });
    const before = victoryPoints(s, 'a');
    act(s, 'a', { type: 'build_village', vertexId: v1 });
    expect(victoryPoints(s, 'a')).toBe(before + 1 + ISLAND_BONUS_POINTS);
    expect(s.islandBonus).toEqual({ a: [island] });
    expect(s.events.some((e) => e.kind === 'island_bonus' && e.player === 'a' && e.island === island && e.points === ISLAND_BONUS_POINTS)).toBe(true);
    expect(buildGameView(s, 'b').players.find((p) => p.id === 'a')!.islands).toBe(1);
    // 섬 땅따먹기: 처음 닿은 사람이 그 섬의 주인으로 남는다
    expect(s.islandClaims).toEqual({ [island]: 'a' });
    expect(buildGameView(s, 'b').islandClaims).toEqual({ [island]: 'a' });
    // b 도 같은 섬에 처음 지으면 받는다
    s.current = 1;
    act(s, 'b', { type: 'build_village', vertexId: v2 });
    expect(s.islandBonus.b).toEqual([island]);
    expect(s.islandClaims).toEqual({ [island]: 'a' });
    // 큰 섬에 지은 마을은 보너스가 없다
    const big = placeableVertices(board, s.buildings).find((v) => board.vertexMap[v].tiles.length === 1)!;
    s.ships.push({ edgeId: seaEdge(big), owner: 'b', builtTurn: 0 });
    act(s, 'b', { type: 'build_village', vertexId: big });
    expect(s.islandBonus.b).toEqual([island]);
  });

  it('섬 맵을 고르면 기본 승리 점수가 14점이 되고, 방장이 바꾼 점수는 그대로 둔다', () => {
    expect(mapWinPoints('islands')).toBe(ISLANDS_WIN_POINTS);
    expect(mapWinPoints('hex')).toBe(WIN_POINTS);
    const m = new RoomManager();
    const made = m.create('방장');
    if ('error' in made) throw new Error(made.error);
    const { room, player } = made;
    expect(m.setSettings(room, player.id, { mapShape: 'islands' })).toBeNull();
    expect(room.winPoints).toBe(14);
    expect(m.setSettings(room, player.id, { mapShape: 'hex' })).toBeNull();
    expect(room.winPoints).toBe(10);
    expect(m.setSettings(room, player.id, { winPoints: 12 })).toBeNull();
    expect(m.setSettings(room, player.id, { mapShape: 'islands' })).toBeNull();
    expect(room.winPoints).toBe(12);
  });
});

describe('해적선', () => {
  it('7이나 기사로 동상 대신 해적선을 옮겨 배 주인에게서 빼앗고, 해적선 둘레에는 배를 띄우거나 옮기지 못한다', () => {
    const s = islandGame();
    const board = boardOf(s);
    const net = board.sea!;
    expect(s.pirate).toMatch(/^c\d+$/);
    expect(net.cellEdges[s.pirate!]).toHaveLength(6);
    // b 의 바닷가 마을과 그 앞 바다의 배
    const coast = placeableVertices(board, s.buildings).find((v) => board.vertexMap[v].tiles.length === 1)!;
    s.buildings.push({ vertexId: coast, owner: 'b', kind: 'village', builtTurn: 0 });
    const shipEdge = net.vertexMap[coast].edges.find((e) => !net.edgeMap[e].coast)!;
    s.ships.push({ edgeId: shipEdge, owner: 'b', builtTurn: 0 });
    const cell = Object.keys(net.cellEdges).find((c) => net.cellEdges[c].includes(shipEdge))!;
    // a 가 7을 굴리고 해적선을 그 바다 칸으로 옮긴다
    act(s, 'a', { type: 'end_turn' });
    s.current = 0;
    s.step = 'roll';
    s.sevenDiscard = false;
    act(s, 'a', { type: 'roll' }, dice(3, 4));
    expect(s.step).toBe('robber');
    expect(pirateTargets(s)).toContain(cell);
    expect(pirateTargets(s)).not.toContain(s.pirate);
    fail(s, 'a', { type: 'move_pirate', cell: s.pirate! }, 'SPOT_INVALID');
    fail(s, 'a', { type: 'move_pirate', cell: 'c9999' }, 'SPOT_INVALID');
    const bRes = Object.values(s.players.b.resources).reduce((n, x) => n + x, 0);
    act(s, 'a', { type: 'move_pirate', cell });
    expect(s.pirate).toBe(cell);
    expect(s.events.some((e) => e.kind === 'pirate' && e.cell === cell)).toBe(true);
    expect(Object.values(s.players.b.resources).reduce((n, x) => n + x, 0)).toBe(bRes - 1);
    expect(s.step).toBe('main');
    // 해적선 둘레의 변에는 b 가 배를 띄우지 못하고, 묶인 배도 옮기지 못한다
    const blocked = new Set(net.cellEdges[cell]);
    expect(buildableShips(board, s.buildings, s.roads, s.ships, 'b', s.pirate).some((e) => blocked.has(e))).toBe(false);
    s.turn = 5;
    expect(shipMoveProblem(s, 'b', shipEdge)).toContain('해적선');
    // 다른 칸으로 다시 옮기면 풀린다
    s.step = 'robber';
    const other = pirateTargets(s).find((c) => !net.cellEdges[c].some((e) => blocked.has(e)))!;
    act(s, 'a', { type: 'move_pirate', cell: other });
    expect(shipMoveProblem(s, 'b', shipEdge) ?? '').not.toContain('해적선');
  });

  it('배가 없는 맵에는 해적선이 없고, 해적선 행동은 바다 칸 ID 만 받는다', () => {
    const s = createGame(['a', 'b'], seeded(3), { rollForOrder: false });
    expect(s.pirate).toBeNull();
    s.phase = 'playing';
    s.turn = 1;
    s.current = 0;
    s.step = 'robber';
    fail(s, s.order[0], { type: 'move_pirate', cell: 'c1' }, 'NOT_ALLOWED');
    expect(parseAction({ type: 'move_pirate', cell: 'c12' })).toEqual({ type: 'move_pirate', cell: 'c12' });
    expect(parseAction({ type: 'move_pirate', cell: 'A1' })).toBeNull();
    expect(parseAction({ type: 'place_ship', edgeId: 's3' })).toEqual({ type: 'place_ship', edgeId: 's3' });
  });
});

describe('금광', () => {
  it('섬 맵의 금광 두 칸은 서로 다른 작은 섬에 있고 섞어도 자리를 지킨다', () => {
    const m = goldenMap('islands');
    const gold = m.tiles.filter((t) => t.kind === 'gold');
    expect(gold).toHaveLength(2);
    const board = boardOf({ tiles: m.tiles, sea: m.sea });
    const islands = gold.map((t) => board.islandOf[t.id]);
    expect(new Set(islands).size).toBe(2);
    expect(islands.every((n) => board.islandSizes[n] <= 3)).toBe(true);
    for (let seed = 1; seed <= 5; seed++) {
      const sm = shuffledMap('islands', seeded(seed));
      expect(sm.tiles.filter((t) => t.kind === 'gold').map((t) => t.id)).toEqual(gold.map((t) => t.id));
    }
  });

  it('금광 숫자가 나오면 닿은 마을은 2장, 도시는 3장을 골라 받고, 모두 고를 때까지 기다린다', () => {
    const s = islandGame();
    const board = boardOf(s);
    const gold = s.tiles.find((t) => t.kind === 'gold')!;
    const n = s.numbers[gold.id];
    const [v1, v2] = board.vertices.filter((v) => v.tiles.includes(gold.id) && v.tiles.length === 1).map((v) => v.id);
    s.buildings.push({ vertexId: v1, owner: 'a', kind: 'city', builtTurn: 0 }, { vertexId: v2, owner: 'b', kind: 'village', builtTurn: 0 });
    s.step = 'roll';
    const d1 = Math.min(6, n - 1);
    act(s, 'a', { type: 'roll' }, dice(d1, n - d1));
    expect(s.goldPicks).toEqual({ a: 3, b: 2 });
    expect(s.step).toBe('gold');
    expect(s.events.find((e) => e.kind === 'roll')).toMatchObject({ gold: { a: 3, b: 2 } });
    fail(s, 'a', { type: 'end_turn' }, 'WRONG_STEP');
    fail(s, 'a', { type: 'gold_pick', bundle: { wood: 1, grain: 0, wool: 0, brick: 0, stone: 0 } }, 'BAD_REQUEST');
    const stone = s.players.a.resources.stone;
    act(s, 'a', { type: 'gold_pick', bundle: { wood: 0, grain: 0, wool: 0, brick: 1, stone: 2 } });
    expect(s.players.a.resources.stone).toBe(stone + 2);
    expect(s.step).toBe('gold');
    // 남이 고른 것은 남에게만 보인다
    act(s, 'b', { type: 'gold_pick', bundle: { wood: 0, grain: 1, wool: 1, brick: 0, stone: 0 } });
    expect(s.step).toBe('main');
    expect(s.goldPicks).toEqual({});
    const pickB = buildGameView(s, 'a').events.find((e) => e.kind === 'gold_pick' && e.player === 'b');
    expect(pickB && 'detail' in pickB && pickB.detail).toBeFalsy();
    fail(s, 'a', { type: 'gold_pick', bundle: { wood: 1, grain: 0, wool: 0, brick: 0, stone: 0 } }, 'NOT_ALLOWED');
  });

  it('은행이 모자라면 남은 만큼만 고르고, 시간이 다 되면 대신 고른다', () => {
    const s = islandGame();
    const board = boardOf(s);
    const gold = s.tiles.find((t) => t.kind === 'gold')!;
    const v = board.vertices.find((x) => x.tiles.includes(gold.id))!.id;
    s.buildings.push({ vertexId: v, owner: 'b', kind: 'city', builtTurn: 0 });
    s.bank = { wood: 1, grain: 0, wool: 0, brick: 0, stone: 0 };
    s.step = 'roll';
    const n = s.numbers[gold.id];
    const d1 = Math.min(6, n - 1);
    act(s, 'a', { type: 'roll' }, dice(d1, n - d1));
    expect(s.goldPicks).toEqual({ b: 3 });
    fail(s, 'b', { type: 'gold_pick', bundle: { wood: 1, grain: 1, wool: 0, brick: 0, stone: 0 } }, 'BAD_REQUEST');
    expect(autoPlay(s, seeded(1))).toBe(true);
    expect(s.goldPicks).toEqual({});
    expect(s.players.b.resources.wood).toBe(11);
    expect(s.step).toBe('main');
  });

  it('시작 배치 중에 받은 금광 몫을 고르지 않았으면 첫 주사위 전에 고른다', () => {
    const s = createGame(['a', 'b'], seeded(5), { map: { shape: 'islands', arrange: 'golden' }, rollForOrder: false });
    // 섬 맵의 금광은 작은 섬에 있어 시작 마을이 닿지 않으므로, 두 번째 시작 마을로 몫이 생긴 것처럼 직접 둔다.
    s.goldPicks = { [s.order[0]]: 1 };
    for (let i = 0; i < 40 && s.phase === 'placement'; i++) autoPlay(s, seeded(i + 1));
    expect(s.phase).toBe('playing');
    expect(s.step).toBe('gold');
    expect(s.resumeStep).toBe('roll');
    autoPlay(s, seeded(9));
    expect(s.goldPicks).toEqual({});
    expect(s.step).toBe('roll');
  });
});
