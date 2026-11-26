// 섬 맵과 배: 바다 칸·바닷길, 배 띄우기·옮기기, 배로 건너가 마을 짓기, 길과 배를 이은 최장 교역로
import { describe, expect, it } from 'vitest';
import { boardOf, type Board } from '../src/shared/board';
import { PIECE_COST, PIECE_LIMIT } from '../src/shared/constants';
import { buildGameView } from '../src/shared/gameView';
import { MAP_SHAPES, goldenMap, mapHasShips, mapSeaCells, maxPlayersFor } from '../src/shared/maps';
import {
  applyAction,
  autoPlay,
  buildableShips,
  buildableVillages,
  createGame,
  longestRoadLength,
  movableShips,
  shipMoveTargets,
  type GameState,
} from '../src/shared/rules';
import { parseAction } from '../src/shared/validate';
import { RoomManager } from '../src/server/rooms';
import { restoreRooms, snapshotRooms } from '../src/server/persist';
import type { GameAction, TileDef } from '../src/shared/types';

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

const near = (a: { q: number; r: number }, b: { q: number; r: number }) => {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 === 1;
};

/** 칸마다 섬 번호 (맞닿은 땅끼리 한 섬) */
function islandsOf(tiles: readonly TileDef[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const t of tiles) {
    if (out.has(t.id)) continue;
    const stack = [t];
    out.set(t.id, n);
    while (stack.length) {
      const cur = stack.pop()!;
      for (const o of tiles) if (!out.has(o.id) && near(cur, o)) (out.set(o.id, n), stack.push(o));
    }
    n++;
  }
  return out;
}

/** 섬 맵 a·b 두 사람 게임을 a 의 차례 교환·건설 단계로 둔다 (자원 넉넉히, 은행 무제한, 시작 배치 없음) */
function islandGame(): GameState {
  const s = createGame(['a', 'b'], seeded(4), { map: { shape: 'islands', arrange: 'golden' }, rollForOrder: false });
  s.order = ['a', 'b'];
  s.phase = 'playing';
  s.turn = 1;
  s.current = 0;
  s.step = 'main';
  s.bank = null;
  s.winPoints = 20;
  for (const id of s.order) s.players[id].resources = { wood: 30, grain: 30, wool: 30, brick: 30, stone: 30 };
  return s;
}

function act(s: GameState, p: string, a: GameAction) {
  const r = applyAction(s, p, a, () => 0);
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

/** 칸 하나에만 닿은 바닷가 꼭짓점 (그 칸의 위쪽 꼭짓점) */
function coastVertex(board: Board, tileId: string): string {
  const t = board.tileMap[tileId];
  const v = board.vertices.find((x) => x.tiles.length === 1 && x.tiles[0] === tileId && x.y < t.r * 1.5);
  if (!v) throw new Error(`바닷가 꼭짓점이 없습니다: ${tileId}`);
  return v.id;
}

/** 바닷길로 from 에서 다른 섬(땅 꼭짓점)까지 가장 짧은 변들 */
function sailTo(board: Board, from: string, home: number, island: Map<string, number>): { edges: string[]; to: string } {
  const net = board.sea!;
  const prev = new Map<string, { v: string; e: string } | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const v = queue.shift()!;
    const land = board.vertexMap[v];
    if (land && v !== from && land.tiles.every((t) => island.get(t) !== home)) {
      const edges: string[] = [];
      for (let cur = v; prev.get(cur); cur = prev.get(cur)!.v) edges.unshift(prev.get(cur)!.e);
      return { edges, to: v };
    }
    // 바다 쪽으로만 나간다 (집 섬의 바닷가를 따라 돌지 않게, 바다 한가운데 변을 먼저)
    for (const e of [...net.vertexMap[v].edges].sort((x, y) => Number(net.edgeMap[x].coast) - Number(net.edgeMap[y].coast))) {
      const d = net.edgeMap[e];
      const next = d.a === v ? d.b : d.a;
      if (prev.has(next)) continue;
      prev.set(next, { v, e });
      queue.push(next);
    }
  }
  throw new Error('다른 섬에 닿지 못했습니다');
}

describe('섬 맵', () => {
  it('88칸 틀에 땅 44칸·바다 44칸이고, 섬 일곱 개(큰 섬 셋, 작은 섬 넷)가 서로 떨어져 있다', () => {
    const m = goldenMap('islands');
    expect(m.tiles).toHaveLength(44);
    const island = islandsOf(m.tiles);
    const sizes = [...new Set(island.values())].map((n) => [...island.values()].filter((x) => x === n).length).sort((a, b) => a - b);
    expect(sizes).toEqual([3, 3, 3, 3, 9, 11, 12]);
    // 큰 섬마다 다섯 자원이 다 있다
    for (const n of new Set(island.values())) {
      const kinds = new Set(m.tiles.filter((t) => island.get(t.id) === n && t.kind !== 'plaza').map((t) => t.kind));
      expect(kinds.size).toBe(Math.min(5, m.tiles.filter((t) => island.get(t.id) === n && t.kind !== 'plaza').length));
    }
    expect(maxPlayersFor('islands')).toBe(8);
    expect(MAP_SHAPES.filter(mapHasShips)).toEqual(['islands']);
  });

  it('바다 칸은 틀 안의 빈 칸 44칸과 땅에 닿은 바깥 칸이고, 땅의 바닷가 변은 모두 배 자리다', () => {
    const m = goldenMap('islands');
    const land = new Set(m.tiles.map((t) => `${t.q},${t.r}`));
    expect(m.sea.every((c) => !land.has(`${c.q},${c.r}`))).toBe(true);
    // 틀(8·9·10·11·12·11·10·9·8 줄) 안의 빈 칸은 모두 바다
    const frame: string[] = [];
    [8, 9, 10, 11, 12, 11, 10, 9, 8].forEach((w, i) => {
      for (let c = 0; c < w; c++) frame.push(`${Math.max(-6, -i - 2) + c},${i - 4}`);
    });
    expect(frame).toHaveLength(88);
    const sea = new Set(m.sea.map((c) => `${c.q},${c.r}`));
    expect(frame.filter((k) => !land.has(k)).every((k) => sea.has(k))).toBe(true);
    expect(frame.filter((k) => !land.has(k))).toHaveLength(44);
    // 땅에 닿은 칸은 모두 바다나 땅이다 (어느 바닷가에나 배를 댄다)
    for (const t of m.tiles)
      for (const [dq, dr] of [[1, 0], [-1, 0], [1, -1], [0, -1], [0, 1], [-1, 1]])
        expect(land.has(`${t.q + dq},${t.r + dr}`) || sea.has(`${t.q + dq},${t.r + dr}`)).toBe(true);
    const board = boardOf({ tiles: m.tiles, sea: m.sea });
    const net = board.sea!;
    const coast = board.edges.filter((e) => e.tiles.length === 1);
    expect(coast.every((e) => net.edgeMap[e.id]?.coast)).toBe(true);
    // 바다 한가운데 변·꼭짓점은 땅 보드와 겹치지 않는 s…·w… 번호다
    for (const e of net.edges) expect(e.coast ? /^e\d+$/.test(e.id) : /^s\d+$/.test(e.id)).toBe(true);
    for (const v of Object.values(net.vertexMap)) expect(board.vertexMap[v.id] ? /^v\d+$/.test(v.id) : /^w\d+$/.test(v.id)).toBe(true);
    // 배를 안 쓰는 맵에는 바다 칸이 없다
    expect(mapSeaCells('hex')).toEqual([]);
    expect(boardOf(createGame(['a', 'b'], seeded(1))).sea).toBeNull();
  });
});

describe('배 띄우기', () => {
  it('바닷가 마을에서 배를 띄우고(목재·양모), 내 배나 마을에 이어서만 띄운다', () => {
    const s = islandGame();
    const board = boardOf(s);
    const v0 = coastVertex(board, 'A1');
    s.buildings.push({ vertexId: v0, owner: 'a', kind: 'village', builtTurn: 0 });
    const spots = buildableShips(board, s.buildings, s.roads, s.ships, 'a');
    expect(spots.sort()).toEqual([...board.sea!.vertexMap[v0].edges].sort());
    const first = board.vertexMap[v0].edges[0];
    act(s, 'a', { type: 'build_ship', edgeId: first });
    expect(s.ships).toEqual([{ edgeId: first, owner: 'a', builtTurn: 1 }]);
    expect(s.players.a.resources.wood).toBe(30 - PIECE_COST.ship.wood);
    expect(s.players.a.resources.wool).toBe(30 - PIECE_COST.ship.wool);
    expect(s.events.at(-1)).toMatchObject({ kind: 'build', piece: 'ship', at: first });
    // 배가 뜬 바닷가 변에는 길을 놓지 못하고, 이어지지 않은 먼 바다에는 띄우지 못한다
    fail(s, 'a', { type: 'build_road', edgeId: first }, 'SPOT_TAKEN');
    const far = board.sea!.edges.find((e) => !e.coast && !buildableShips(board, s.buildings, s.roads, s.ships, 'a').includes(e.id))!;
    fail(s, 'a', { type: 'build_ship', edgeId: far.id }, 'NOT_CONNECTED');
    // 남의 차례에는 못 띄운다
    fail(s, 'b', { type: 'build_ship', edgeId: board.sea!.vertexMap[v0].edges[1] }, 'NOT_YOUR_TURN');
  });

  it('길 끝(마을 없는 꼭짓점)에서는 배로 넘어가지 못하고, 길이 놓인 바닷가 변에는 배를 띄우지 못한다', () => {
    const s = islandGame();
    const board = boardOf(s);
    const v0 = coastVertex(board, 'A1');
    s.buildings.push({ vertexId: v0, owner: 'a', kind: 'village', builtTurn: 0 });
    // 바닷가를 따라 길 하나: v0 → v1
    const road = board.vertexMap[v0].edges.find((e) => board.edgeMap[e].tiles.length === 1)!;
    s.roads.push({ edgeId: road, owner: 'a', builtTurn: 0 });
    const v1 = board.edgeMap[road].a === v0 ? board.edgeMap[road].b : board.edgeMap[road].a;
    const spots = buildableShips(board, s.buildings, s.roads, s.ships, 'a');
    expect(spots).not.toContain(road);
    for (const e of board.sea!.vertexMap[v1].edges) {
      const d = board.sea!.edgeMap[e];
      if (d.a !== v0 && d.b !== v0) expect(spots).not.toContain(e);
    }
    fail(s, 'a', { type: 'build_ship', edgeId: road }, 'SPOT_TAKEN');
  });

  it('배를 이어 다른 섬에 닿으면 그 섬에 마을을 짓고, 길 건설 카드로도 배를 띄운다', () => {
    const s = islandGame();
    const board = boardOf(s);
    const island = islandsOf(s.tiles);
    const v0 = coastVertex(board, 'A1');
    s.buildings.push({ vertexId: v0, owner: 'a', kind: 'village', builtTurn: 0 });
    const { edges, to } = sailTo(board, v0, island.get('A1')!, island);
    expect(edges.length).toBeGreaterThan(1);
    expect(buildableVillages(board, s.buildings, s.roads, 'a', s.ships)).not.toContain(to);
    // 길 건설 카드: 공짜로 둘
    s.players.a.devCards.push({ kind: 'road_building', boughtTurn: 0 });
    act(s, 'a', { type: 'play_dev', kind: 'road_building' });
    const wood = s.players.a.resources.wood;
    act(s, 'a', { type: 'build_ship', edgeId: edges[0] });
    act(s, 'a', { type: 'build_ship', edgeId: edges[1] });
    expect(s.players.a.resources.wood).toBe(wood);
    expect(s.step).toBe('main');
    expect(s.events.filter((e) => e.kind === 'build' && e.piece === 'ship' && e.free)).toHaveLength(2);
    for (const e of edges.slice(2)) act(s, 'a', { type: 'build_ship', edgeId: e });
    expect(buildableVillages(board, s.buildings, s.roads, 'a', s.ships)).toContain(to);
    act(s, 'a', { type: 'build_village', vertexId: to });
    expect(s.buildings.find((b) => b.vertexId === to)?.owner).toBe('a');
    expect(board.vertexMap[to].tiles.every((t) => island.get(t) !== island.get('A1'))).toBe(true);
    // 양 끝이 내 마을로 닫힌 항로의 배는 옮기지 못한다
    s.turn = 2;
    expect(movableShips(s, 'a')).toEqual([]);
  });
});

describe('배 옮기기', () => {
  it('항로 끝의 배 한 척을 한 턴에 한 번 옮긴다. 이번 턴에 띄운 배와 항로 가운데 배는 그대로다', () => {
    const s = islandGame();
    const board = boardOf(s);
    const net = board.sea!;
    const island = islandsOf(s.tiles);
    const v0 = coastVertex(board, 'A1');
    s.buildings.push({ vertexId: v0, owner: 'a', kind: 'village', builtTurn: 0 });
    const { edges } = sailTo(board, v0, island.get('A1')!, island);
    act(s, 'a', { type: 'build_ship', edgeId: edges[0] });
    act(s, 'a', { type: 'build_ship', edgeId: edges[1] });
    const r = fail(s, 'a', { type: 'move_ship', from: edges[1], to: net.vertexMap[v0].edges.find((e) => e !== edges[0])! }, 'NOT_ALLOWED');
    expect(!r.ok && r.message).toContain('이번 턴에 띄운');
    // 다음 차례: 끝의 배(edges[1])만 옮길 수 있다
    act(s, 'a', { type: 'end_turn' });
    s.current = 0;
    s.turn = 3;
    s.step = 'main';
    expect(movableShips(s, 'a')).toEqual([edges[1]]);
    fail(s, 'a', { type: 'move_ship', from: edges[0], to: edges[2] }, 'NOT_ALLOWED');
    const targets = shipMoveTargets(s, 'a', edges[1]);
    expect(targets).not.toContain(edges[1]);
    // 남은 배(edges[0])나 마을에 이어지지 않는 곳으로는 못 옮긴다
    const loose = net.edges.find((e) => !targets.includes(e.id) && e.id !== edges[1] && !s.ships.some((x) => x.edgeId === e.id))!;
    fail(s, 'a', { type: 'move_ship', from: edges[1], to: loose.id }, 'NOT_CONNECTED');
    const to = targets.find((e) => e !== edges[2])!;
    act(s, 'a', { type: 'move_ship', from: edges[1], to });
    expect(s.ships.map((x) => x.edgeId).sort()).toEqual([edges[0], to].sort());
    expect(s.shipMoved).toBe(true);
    expect(s.events.at(-1)).toMatchObject({ kind: 'move_ship', player: 'a', from: edges[1], to });
    const again = fail(s, 'a', { type: 'move_ship', from: to, to: edges[1] }, 'NOT_ALLOWED');
    expect(!again.ok && again.message).toContain('한 번');
    // 턴을 넘기면 다시 옮길 수 있다
    act(s, 'a', { type: 'end_turn' });
    expect(s.shipMoved).toBe(false);
  });
});

describe('최장 교역로', () => {
  it('길과 배는 내 마을·도시가 선 꼭짓점에서만 이어 센다', () => {
    const s = islandGame();
    const board = boardOf(s);
    const net = board.sea!;
    const island = islandsOf(s.tiles);
    const v0 = coastVertex(board, 'A1');
    s.buildings.push({ vertexId: v0, owner: 'a', kind: 'village', builtTurn: 0 });
    // 마을에서 땅 쪽으로 길 둘
    const inland = board.vertexMap[v0].edges.find((e) => !net.edgeMap[e] || board.edgeMap[e].tiles.length === 1)!;
    const r1 = inland;
    const v1 = board.edgeMap[r1].a === v0 ? board.edgeMap[r1].b : board.edgeMap[r1].a;
    const r2 = board.vertexMap[v1].edges.find((e) => e !== r1)!;
    act(s, 'a', { type: 'build_road', edgeId: r1 });
    act(s, 'a', { type: 'build_road', edgeId: r2 });
    // 마을에서 바다 쪽으로 배 셋
    const { edges } = sailTo(board, v0, island.get('A1')!, island);
    const ships = edges.filter((e) => e !== r1).slice(0, 3);
    for (const e of ships) act(s, 'a', { type: 'build_ship', edgeId: e });
    expect(longestRoadLength(board, s.roads, s.buildings, 'a', s.ships)).toBe(5);
    expect(s.longestRoad).toEqual({ holder: 'a', length: 5 });
    expect(s.events.some((e) => e.kind === 'award' && e.award === 'longest_road' && e.player === 'a')).toBe(true);
    // 마을이 없으면 길과 배가 따로 센다
    const noTown = { ...board };
    expect(longestRoadLength(noTown, s.roads, [], 'a', s.ships)).toBe(3);
    // 남의 마을이 서면 끊긴다
    expect(longestRoadLength(board, s.roads, [{ vertexId: v0, owner: 'b', kind: 'village', builtTurn: 0 }], 'a', s.ships)).toBe(3);
  });
});

describe('배를 쓰지 않는 맵·입력·저장', () => {
  it('배가 없는 맵에서는 배를 띄우지 못한다', () => {
    const s = createGame(['a', 'b'], seeded(2), { rollForOrder: false });
    s.phase = 'playing';
    s.turn = 1;
    s.current = 0;
    s.step = 'main';
    fail(s, s.order[0], { type: 'build_ship', edgeId: 'e1' }, 'NOT_ALLOWED');
    expect(s.sea).toEqual([]);
    expect(s.pieceLimits.ship).toBe(PIECE_LIMIT.ship);
  });

  it('배 행동은 바닷가 변(e…)과 바다 한가운데 변(s…)만 받는다', () => {
    expect(parseAction({ type: 'build_ship', edgeId: 's12' })).toEqual({ type: 'build_ship', edgeId: 's12' });
    expect(parseAction({ type: 'build_ship', edgeId: 'e3' })).toEqual({ type: 'build_ship', edgeId: 'e3' });
    expect(parseAction({ type: 'build_ship', edgeId: 'w1' })).toBeNull();
    expect(parseAction({ type: 'build_road', edgeId: 's1' })).toBeNull();
    expect(parseAction({ type: 'move_ship', from: 's1', to: 'e2' })).toEqual({ type: 'move_ship', from: 's1', to: 'e2' });
    expect(parseAction({ type: 'move_ship', from: 's1' })).toBeNull();
  });

  it('화면 정보에 바다 칸·배·배 옮김이 실리고 사람마다 띄운 배 수가 공개된다', () => {
    const s = islandGame();
    const board = boardOf(s);
    const v0 = coastVertex(board, 'A1');
    s.buildings.push({ vertexId: v0, owner: 'a', kind: 'village', builtTurn: 0 });
    act(s, 'a', { type: 'build_ship', edgeId: board.sea!.vertexMap[v0].edges[0] });
    const v = buildGameView(s, 'b');
    expect(v.sea).toEqual(s.sea);
    expect(v.ships).toEqual(s.ships);
    expect(v.shipMoved).toBe(false);
    expect(v.players.find((p) => p.id === 'a')!.ships).toBe(1);
    expect(v.players.find((p) => p.id === 'a')!.roadLength).toBe(1);
  });

  it('배가 생기기 전에 저장한 게임은 바다도 배도 없이 되살린다', () => {
    const m = new RoomManager();
    const made = m.create('방장');
    if ('error' in made) throw new Error(made.error);
    const joined = m.join(made.room.code, '손님');
    if ('error' in joined) throw new Error(joined.error);
    for (const p of made.room.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(made.room, made.player.id)).toBeNull();
    m.stopAllClocks();
    const data = JSON.parse(snapshotRooms(m.rooms.values()));
    delete data.rooms[0].game.sea;
    delete data.rooms[0].game.ships;
    delete data.rooms[0].game.shipMoved;
    delete data.rooms[0].game.pieceLimits.ship;
    delete data.rooms[0].pieceLimits.ship;
    const back = restoreRooms(JSON.stringify(data)).rooms[0];
    expect(back.game!.sea).toEqual([]);
    expect(back.game!.ships).toEqual([]);
    expect(back.game!.shipMoved).toBe(false);
    expect(back.game!.pieceLimits.ship).toBe(PIECE_LIMIT.ship);
    expect(back.pieceLimits.ship).toBe(PIECE_LIMIT.ship);
  });

  it('섬 맵 8인을 섞기로 자동 진행해도 보드 밖 자리를 쓰지 않는다', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const random = seeded(11);
    const s = createGame(ids, random, { map: { shape: 'islands', arrange: 'shuffle' } });
    const board = boardOf(s);
    for (let i = 0; i < 1500 && s.phase !== 'finished'; i++) autoPlay(s, random);
    expect(s.turn).toBeGreaterThan(30);
    expect(new Set(s.buildings.map((b) => b.owner)).size).toBe(8);
    expect(s.buildings.every((b) => board.vertexMap[b.vertexId])).toBe(true);
    expect(s.roads.every((r) => board.edgeMap[r.edgeId])).toBe(true);
    expect(s.ships.every((x) => board.sea!.edgeMap[x.edgeId])).toBe(true);
  });
});
