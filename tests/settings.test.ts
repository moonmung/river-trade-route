// 일대일(2명) 대결과 방장이 정하는 승리 점수(10~20점)
import { describe, expect, it } from 'vitest';
import { EDGES, boardOf } from '../src/shared/board';
import { DEV_COST, WIN_POINTS } from '../src/shared/constants';
import { applyAction, createGame, placeableVertices, victoryPoints, type GameState } from '../src/shared/rules';
import { RoomManager } from '../src/server/rooms';

const noShuffle = () => 0.999999; // Fisher–Yates 에서 항상 자기 자리 → 순서 유지

/** 그 꼭짓점에 닿은 변 중 아직 길이 없는 첫 변 */
function freeEdgeAt(s: GameState, v: string): string {
  const taken = new Set(s.roads.map((r) => r.edgeId));
  const edge = EDGES.find((e) => (e.a === v || e.b === v) && !taken.has(e.id));
  if (!edge) throw new Error('변 없음');
  return edge.id;
}

/** 두 사람이 시작 배치를 마친 게임 (자리 순서 a → b → b → a) */
function setup2(winPoints?: number): GameState {
  const s = createGame(['a', 'b'], noShuffle, winPoints);
  for (const p of ['a', 'b', 'b', 'a']) {
    const v = placeableVertices(boardOf(s), s.buildings)[0];
    const r = applyAction(s, p, { type: 'place', vertexId: v, edgeId: freeEdgeAt(s, v) }, () => 0);
    if (!r.ok) throw new Error(r.message);
  }
  return s;
}

describe('일대일 대결', () => {
  it('두 사람으로 게임을 열고 시작 배치를 한 바퀴 돌고 거꾸로 돈다', () => {
    const s = setup2();
    expect(s.phase).toBe('playing');
    expect(s.order).toEqual(['a', 'b']);
    expect(s.buildings.filter((b) => b.owner === 'a')).toHaveLength(2);
    expect(s.buildings.filter((b) => b.owner === 'b')).toHaveLength(2);
  });

  it('한 사람이나 다섯 사람으로는 열 수 없다', () => {
    expect(() => createGame(['a'])).toThrow();
    expect(() => createGame(['a', 'b', 'c', 'd', 'e'])).toThrow();
  });
});

describe('승리 점수', () => {
  it('기본은 10점이고 10~20점 밖의 값은 받지 않는다', () => {
    expect(createGame(['a', 'b']).winPoints).toBe(WIN_POINTS);
    expect(createGame(['a', 'b'], Math.random, 20).winPoints).toBe(20);
    expect(() => createGame(['a', 'b'], Math.random, 9)).toThrow();
    expect(() => createGame(['a', 'b'], Math.random, 21)).toThrow();
    expect(() => createGame(['a', 'b'], Math.random, 12.5)).toThrow();
  });

  it('정한 점수(12점)에 닿기 전에는 이어 가고 닿는 순간 이긴다', () => {
    const s = setup2(12);
    const me = s.order[s.current];
    s.step = 'main';
    // 시작 마을 2점 + 숨긴 승점 카드 9장 = 11점
    s.players[me].devCards = Array.from({ length: 9 }, () => ({ kind: 'victory' as const, boughtTurn: 0 }));
    // 발전 카드 두 장 값
    s.players[me].resources = { ...DEV_COST, grain: DEV_COST.grain * 2, wool: DEV_COST.wool * 2, stone: DEV_COST.stone * 2 };
    expect(victoryPoints(s, me, true)).toBe(11);

    s.devDeck.push('knight');
    expect(applyAction(s, me, { type: 'buy_dev' }, () => 0).ok).toBe(true);
    expect(s.phase).toBe('playing');

    s.devDeck.push('victory');
    expect(applyAction(s, me, { type: 'buy_dev' }, () => 0).ok).toBe(true);
    expect(s.phase).toBe('finished');
    expect(s.result?.ranking[0].playerId).toBe(me);
  });
});

describe('방 설정', () => {
  it('방을 만들 때 정한 승리 점수가 게임에 들어가고, 방장만 대기실에서 바꿀 수 있다', () => {
    const m = new RoomManager();
    const made = m.create('방장', 15);
    if ('error' in made) throw new Error(made.error);
    const { room, player: host } = made;
    expect(room.winPoints).toBe(15);
    const joined = m.join(room.code, '손님');
    if ('error' in joined) throw new Error(joined.error);
    const guest = joined.player;

    expect(m.setWinPoints(room, guest.id, 12)).not.toBeNull();
    expect(m.setWinPoints(room, host.id, 25)).not.toBeNull();
    guest.ready = true;
    expect(m.setWinPoints(room, host.id, 18)).toBeNull();
    expect(room.winPoints).toBe(18);
    // 점수를 바꿔도 손님의 준비는 풀리지 않는다
    expect(guest.ready).toBe(true);
    expect(m.setSettings(room, host.id, { sevenDiscard: false, turnSeconds: 90 })).toBeNull();
    expect(guest.ready).toBe(true);

    for (const p of room.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(room, host.id)).toBeNull();
    expect(room.game?.winPoints).toBe(18);
    expect(room.game?.order).toHaveLength(2);
    // 게임이 시작되면 바꿀 수 없다
    expect(m.setWinPoints(room, host.id, 10)).not.toBeNull();
  });

  it('범위를 벗어난 점수로는 방을 만들 수 없다', () => {
    const m = new RoomManager();
    expect('error' in m.create('방장', 30)).toBe(true);
    expect('error' in m.create('방장', '12')).toBe(true);
  });
});
