// 순서 정하기 주사위, 마을 → 길로 나눠 놓는 시작 배치, 자원 보유 한도, 차례 시간이 다 됐을 때의 자동 진행
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VERTEX_MAP } from '../src/shared/board';
import { bundleTotal } from '../src/shared/constants';
import {
  applyAction,
  autoPlay,
  clockHolders,
  clockKey,
  createGame,
  currentPlayer,
  placeableVertices,
  placementPlayer,
  setupRoadEdges,
  type GameState,
} from '../src/shared/rules';
import type { GameAction } from '../src/shared/types';
import { RoomManager } from '../src/server/rooms';

/** 굴릴 때마다 주어진 주사위 값을 차례로 내는 난수 (한 번 굴리면 두 개를 쓴다) */
function rolls(...pairs: [number, number][]): () => number {
  const vals = pairs.flat().map((d) => (d - 1) / 6 + 0.01);
  let i = 0;
  return () => vals[i++ % vals.length];
}

function act(s: GameState, p: string, a: GameAction, random: () => number = () => 0): void {
  const r = applyAction(s, p, a, random);
  if (!r.ok) throw new Error(`${p} ${a.type}: ${r.message}`);
}

describe('순서 정하기 주사위', () => {
  it('모두 굴리면 높은 사람부터 자리를 잡고 가장 낮은 사람이 마지막이다', () => {
    const s = createGame(['a', 'b', 'c'], Math.random, { rollForOrder: true });
    expect(s.phase).toBe('order');
    expect(s.startPending).toEqual(['a', 'b', 'c']);
    expect(clockHolders(s)).toEqual(['a', 'b', 'c']);
    // 누구든 먼저 굴릴 수 있다 (동시에 굴린다)
    act(s, 'c', { type: 'order_roll' }, rolls([6, 5]));
    expect(applyAction(s, 'c', { type: 'order_roll' }, rolls([1, 1])).ok).toBe(false);
    act(s, 'a', { type: 'order_roll' }, rolls([1, 2]));
    expect(s.phase).toBe('order');
    act(s, 'b', { type: 'order_roll' }, rolls([4, 4]));
    expect(s.phase).toBe('placement');
    expect(s.order).toEqual(['c', 'b', 'a']);
    expect(placementPlayer(s)).toBe('c');
    expect(s.events.at(-1)).toMatchObject({ kind: 'game_start', order: ['c', 'b', 'a'] });
  });

  it('같은 수가 나온 사람들만 다시 굴려 그 사이 순서를 정한다', () => {
    const s = createGame(['a', 'b', 'c'], Math.random, { rollForOrder: true });
    act(s, 'a', { type: 'order_roll' }, rolls([3, 4]));
    act(s, 'b', { type: 'order_roll' }, rolls([2, 2]));
    const keyBefore = clockKey(s);
    act(s, 'c', { type: 'order_roll' }, rolls([5, 2]));
    // a 와 c 가 7로 같다 → 둘만 다시 굴리고 b(4)는 마지막으로 정해져 있다
    expect(s.phase).toBe('order');
    expect(s.startPending).toEqual(['a', 'c']);
    expect(s.events.at(-1)).toMatchObject({ kind: 'order_tie', players: ['a', 'c'], total: 7 });
    expect(clockKey(s)).not.toBe(keyBefore);
    expect(applyAction(s, 'b', { type: 'order_roll' }, rolls([6, 6])).ok).toBe(false);
    act(s, 'c', { type: 'order_roll' }, rolls([6, 6]));
    act(s, 'a', { type: 'order_roll' }, rolls([1, 1]));
    expect(s.order).toEqual(['c', 'a', 'b']);
  });

  it('시간이 다 되면 아직 굴리지 않은 사람의 주사위를 대신 굴린다', () => {
    const s = createGame(['a', 'b'], Math.random, { rollForOrder: true });
    act(s, 'a', { type: 'order_roll' }, rolls([6, 6]));
    expect(autoPlay(s, rolls([1, 1]))).toBe(true);
    expect(s.order).toEqual(['a', 'b']);
    expect(s.events.some((e) => e.kind === 'timeout' && e.player === 'b')).toBe(true);
  });
});

describe('시작 배치: 마을을 짓고 그다음 길', () => {
  it('마을을 먼저 지으면 모두에게 보이고, 그 마을에 붙여 길을 놓아야 다음 사람으로 넘어간다', () => {
    const s = createGame(['a', 'b'], () => 0.999999);
    const v = placeableVertices(s.buildings)[0];
    expect(applyAction(s, 'a', { type: 'place_road', edgeId: VERTEX_MAP[v].edges[0] }, () => 0)).toMatchObject({ ok: false, code: 'WRONG_STEP' });
    act(s, 'a', { type: 'place_village', vertexId: v });
    expect(s.buildings).toEqual([{ vertexId: v, owner: 'a', kind: 'village', builtTurn: 0 }]);
    expect(s.setupVillage).toBe(v);
    expect(placementPlayer(s)).toBe('a');
    // 길을 놓기 전에는 마을을 하나 더 지을 수 없다
    const other = placeableVertices(s.buildings)[3];
    expect(applyAction(s, 'a', { type: 'place_village', vertexId: other }, () => 0)).toMatchObject({ ok: false, code: 'WRONG_STEP' });
    // 다른 마을에 붙은 길은 안 된다
    const far = VERTEX_MAP[other].edges.find((e) => !VERTEX_MAP[v].edges.includes(e))!;
    expect(applyAction(s, 'a', { type: 'place_road', edgeId: far }, () => 0)).toMatchObject({ ok: false, code: 'NOT_CONNECTED' });
    act(s, 'a', { type: 'place_road', edgeId: setupRoadEdges(s.roads, v)[0] });
    expect(s.setupVillage).toBeNull();
    expect(placementPlayer(s)).toBe('b');
    const steps = s.events.filter((e) => e.kind === 'placement').map((e) => (e.kind === 'placement' ? e.step : null));
    expect(steps).toEqual(['village', 'road']);
  });

  it('두 번째 시작 마을은 마을을 지을 때 자원을 받는다', () => {
    const s = createGame(['a', 'b'], () => 0.999999);
    for (const p of ['a', 'b', 'b']) {
      const v = placeableVertices(s.buildings)[0];
      act(s, p, { type: 'place_village', vertexId: v });
      act(s, p, { type: 'place_road', edgeId: setupRoadEdges(s.roads, v)[0] });
    }
    const inner = placeableVertices(s.buildings).find((v) => VERTEX_MAP[v].tiles.length === 3 && !VERTEX_MAP[v].tiles.includes('C3'))!;
    act(s, 'a', { type: 'place_village', vertexId: inner });
    expect(bundleTotal(s.players.a.resources)).toBe(3);
    act(s, 'a', { type: 'place_road', edgeId: setupRoadEdges(s.roads, inner)[0] });
    expect(s.phase).toBe('playing');
    expect(s.turn).toBe(1);
  });

  it('시간이 다 되면 점이 가장 많은 자리에 마을과 길을 대신 놓는다', () => {
    const s = createGame(['a', 'b'], () => 0.999999);
    act(s, 'a', { type: 'place_village', vertexId: placeableVertices(s.buildings)[0] });
    expect(autoPlay(s, () => 0)).toBe(true);
    expect(placementPlayer(s)).toBe('b');
    expect(autoPlay(s, () => 0)).toBe(true);
    expect(s.buildings.filter((b) => b.owner === 'b')).toHaveLength(1);
    expect(s.roads.filter((r) => r.owner === 'b')).toHaveLength(1);
  });
});

/** 시작 배치를 마친 두 사람 게임 */
function playing(handLimit?: number): GameState {
  const s = createGame(['a', 'b'], () => 0.999999, { handLimit });
  while (s.phase === 'placement') autoPlay(s, () => 0);
  return s;
}

describe('자원 보유 한도', () => {
  it('7이 나오면 정한 한도보다 많이 든 사람만 절반을 버린다', () => {
    const s = playing(10);
    expect(s.handLimit).toBe(10);
    const me = currentPlayer(s)!;
    const other = s.order.find((id) => id !== me)!;
    s.players[me].resources = { wood: 10, grain: 0, wool: 0, brick: 0, stone: 0 };
    s.players[other].resources = { wood: 6, grain: 5, wool: 0, brick: 0, stone: 0 };
    act(s, me, { type: 'roll' }, rolls([3, 4]));
    expect(s.discards).toEqual({ [other]: 5 });
  });

  it('범위를 벗어난 한도로는 게임을 만들 수 없다', () => {
    expect(() => createGame(['a', 'b'], Math.random, { handLimit: 4 })).toThrow();
    expect(() => createGame(['a', 'b'], Math.random, { handLimit: 21 })).toThrow();
  });
});

describe('차례 시간 자동 진행', () => {
  it('차례인 사람의 시간이 다 되면 굴리고 턴을 넘긴다', () => {
    const s = playing();
    const me = currentPlayer(s)!;
    const turn = s.turn;
    expect(autoPlay(s, rolls([2, 3]))).toBe(true);
    expect(s.turn).toBe(turn + 1);
    expect(currentPlayer(s)).not.toBe(me);
    expect(s.events.some((e) => e.kind === 'roll' && e.player === me)).toBe(true);
  });

  it('7이 나와 다른 사람이 버려야 하면 그 사람들의 시간으로 넘어가고, 버리기 시간이 다 되면 무작위로 버린다', () => {
    const s = playing();
    const me = currentPlayer(s)!;
    const other = s.order.find((id) => id !== me)!;
    s.players[other].resources = { wood: 4, grain: 4, wool: 2, brick: 0, stone: 0 };
    const key = clockKey(s);
    autoPlay(s, rolls([3, 4]));
    expect(s.step).toBe('discard');
    expect(clockHolders(s)).toEqual([other]);
    expect(clockKey(s)).not.toBe(key);
    autoPlay(s, () => 0.5);
    expect(bundleTotal(s.players[other].resources)).toBe(5);
    // 다 버리면 차례인 사람이 다시 처음부터 잰다
    expect(s.step).toBe('robber');
    expect(clockHolders(s)).toEqual([me]);
    autoPlay(s, () => 0);
    expect(currentPlayer(s)).toBe(other);
  });
});

describe('방 규칙과 차례 시계', () => {
  afterEach(() => vi.useRealTimers());

  function startedRoom(m: RoomManager, turnSeconds?: number) {
    const made = m.create('방장');
    if ('error' in made) throw new Error(made.error);
    const joined = m.join(made.room.code, '손님');
    if ('error' in joined) throw new Error(joined.error);
    const { room } = made;
    if (turnSeconds !== undefined) expect(m.setSettings(room, made.player.id, { turnSeconds })).toBeNull();
    expect(m.setSettings(room, made.player.id, { handLimit: 9 })).toBeNull();
    for (const p of room.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(room, made.player.id)).toBeNull();
    return room;
  }

  it('방장만 한도와 차례 시간을 바꾸고, 틀린 값이 하나라도 있으면 아무것도 바꾸지 않는다', () => {
    const m = new RoomManager();
    const made = m.create('방장');
    if ('error' in made) throw new Error(made.error);
    const { room, player } = made;
    expect(room.handLimit).toBe(7);
    expect(room.turnSeconds).toBe(60);
    expect(m.setSettings(room, player.id, { handLimit: 12, turnSeconds: 77 })).not.toBeNull();
    expect(room.handLimit).toBe(7);
    expect(m.setSettings(room, player.id, { handLimit: 12, turnSeconds: 90 })).toBeNull();
    expect([room.handLimit, room.turnSeconds]).toEqual([12, 90]);
    expect(m.setSettings(room, 'someone', { handLimit: 8 })).not.toBeNull();
  });

  it('게임을 시작하면 순서 정하기부터 하고, 시간이 다 되면 서버가 대신 굴린다', () => {
    vi.useFakeTimers();
    const m = new RoomManager();
    let autos = 0;
    m.onAutoPlay = () => autos++;
    const room = startedRoom(m, 30);
    expect(room.game!.phase).toBe('order');
    expect(room.game!.handLimit).toBe(9);
    expect(m.deadline(room)).toBe(Date.now() + 30_000);
    vi.advanceTimersByTime(29_000);
    expect(autos).toBe(0);
    vi.advanceTimersByTime(1_500);
    expect(autos).toBe(1);
    // 같은 수가 나왔으면 다시 굴리는 중, 아니면 시작 배치로 넘어갔다
    expect(['order', 'placement']).toContain(room.game!.phase);
    expect(m.deadline(room)).toBeGreaterThan(Date.now());
  });

  it('아무도 접속해 있지 않으면 시계가 멈추고, 제한 시간 0 은 시계를 쓰지 않는다', () => {
    vi.useFakeTimers();
    const m = new RoomManager();
    const room = startedRoom(m);
    expect(m.deadline(room)).not.toBeNull();
    for (const p of room.players) p.connected = false;
    m.syncClock(room);
    expect(m.deadline(room)).toBeNull();

    const m2 = new RoomManager();
    const room2 = startedRoom(m2, 0);
    expect(m2.deadline(room2)).toBeNull();
  });
});
