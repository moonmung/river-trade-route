import { describe, expect, it } from 'vitest';
import { CONTRACTS, FORECAST, NEIGHBORS, TILE_MAP, bundleTotal } from '../src/shared/constants';
import {
  applyAction,
  buildableTiles,
  computeResult,
  createGame,
  currentPlayer,
  firstPlayer,
  placementOrder,
  placementPlayer,
  type GameState,
} from '../src/shared/rules';
import type { Bundle, GameAction } from '../src/shared/types';

const ids3 = ['p1', 'p2', 'p3'];
const noShuffle = () => 0.999999; // Fisher–Yates 에서 항상 자기 자리 → 순서 유지

function act(s: GameState, p: string, a: GameAction) {
  const r = applyAction(s, p, a);
  if (!r.ok) throw new Error(`${p} ${a.type}: ${r.message}`);
  return r;
}

function expectFail(s: GameState, p: string, a: GameAction, code?: string) {
  const before = JSON.stringify(s);
  const r = applyAction(s, p, a);
  expect(r.ok).toBe(false);
  if (!r.ok && code) expect(r.code).toBe(code);
  // 거절된 요청은 상태를 바꾸지 않는다 (수락 실패로 제안이 닫히는 예외 제외)
  if (a.type !== 'trade_accept') expect(JSON.stringify(s)).toBe(before);
  return r;
}

function bundle(wood = 0, grain = 0, stone = 0): Bundle {
  return { wood, grain, stone };
}

/**
 * p3 → p2 → p1 순서로 시작 거점을 놓는다 (마지막 자리부터 역순).
 * 기본: p1 목재 A3, p2 석재 D4, p3 곡물 E1.
 * 보드: 목재 A3 B2 C1 C4 D2 E3 / 곡물 A1 B3 C2 C5 D3 E1 / 석재 A2 B1 B4 D1 D4 E2 / 시장 C3
 */
function setup3(tiles: [string, string, string] = ['A3', 'D4', 'E1']): GameState {
  const s = createGame(ids3, noShuffle);
  act(s, 'p3', { type: 'place', tileId: tiles[2] });
  act(s, 'p2', { type: 'place', tileId: tiles[1] });
  act(s, 'p1', { type: 'place', tileId: tiles[0] });
  return s;
}

describe('시작', () => {
  it('순서를 섞고 마지막 자리부터 역순으로 시작 거점을 놓는다', () => {
    const s = createGame(ids3, noShuffle);
    expect(s.order).toEqual(ids3);
    expect(placementOrder(s)).toEqual(['p3', 'p2', 'p1']);
    expect(placementPlayer(s)).toBe('p3');
    for (const id of ids3) expect(s.players[id].resources).toEqual(bundle(1, 1, 1));
  });

  it('서버 난수로 자리 순서를 섞는다', () => {
    const orders = new Set<string>();
    for (let i = 0; i < 50; i++) orders.add(createGame(ids3).order.join(','));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('차례가 아니거나 시장·이미 찬 칸이면 거절한다', () => {
    const s = createGame(ids3, noShuffle);
    expectFail(s, 'p1', { type: 'place', tileId: 'A1' }, 'NOT_YOUR_TURN');
    expectFail(s, 'p3', { type: 'place', tileId: 'C3' }, 'TILE_INVALID');
    act(s, 'p3', { type: 'place', tileId: 'A1' });
    expectFail(s, 'p2', { type: 'place', tileId: 'A1' }, 'TILE_TAKEN');
    expectFail(s, 'p2', { type: 'build', tileId: 'A2' }, 'WRONG_PHASE');
  });

  it('README 예시: 목재 예보 1라운드에 목재 칸에서 시작하면 목재 3·곡물 1·석재 1', () => {
    const s = setup3(['A3', 'D4', 'E1']); // p1 목재, p2 석재, p3 곡물
    expect(FORECAST[0]).toBe('wood');
    expect(s.phase).toBe('playing');
    expect(s.round).toBe(1);
    expect(s.players.p1.resources).toEqual(bundle(3, 1, 1));
    expect(s.players.p2.resources).toEqual(bundle(1, 1, 2));
    expect(s.players.p3.resources).toEqual(bundle(1, 2, 1));
    expect(currentPlayer(s)).toBe('p1');
    expect(s.actionsLeft).toBe(2);
  });
});

describe('턴과 라운드', () => {
  it('행동은 최대 2회, 같은 행동 반복 가능, 일찍 끝낼 수 있다', () => {
    const s = setup3();
    s.players.p1.resources = bundle(6, 0, 0);
    act(s, 'p1', { type: 'market', give: 'wood', get: 'stone' });
    act(s, 'p1', { type: 'market', give: 'wood', get: 'stone' });
    expect(s.actionsLeft).toBe(0);
    expectFail(s, 'p1', { type: 'market', give: 'wood', get: 'grain' }, 'NO_ACTIONS');
    act(s, 'p1', { type: 'end_turn' });
    expect(currentPlayer(s)).toBe('p2');
    act(s, 'p2', { type: 'end_turn' }); // 행동 없이 일찍 끝내기
    expect(currentPlayer(s)).toBe('p3');
  });

  it('모두 턴을 끝내면 선 플레이어가 한 자리씩 넘어가고 계약이 초기화된다', () => {
    const s = setup3();
    expect(firstPlayer(s)).toBe('p1');
    act(s, 'p1', { type: 'deliver', contractId: 'raft' }); // 목재 3 → 2,1 사용
    expect(s.contractsDone.raft).toBe('p1');
    for (const p of ['p1', 'p2', 'p3']) act(s, p, { type: 'end_turn' });
    expect(s.round).toBe(2);
    expect(firstPlayer(s)).toBe('p2');
    expect(currentPlayer(s)).toBe('p2');
    expect(s.contractsDone).toEqual({});
    for (const p of ['p2', 'p3', 'p1']) act(s, p, { type: 'end_turn' });
    expect(firstPlayer(s)).toBe('p3');
  });

  it('공동 생산: 거점마다 1개, 예보와 같으면 1개 더, 새 거점은 다음 라운드부터', () => {
    const s = setup3(['A3', 'D4', 'E1']);
    // p1: 목재 칸 A3. 1라운드에 붙어 있는 B4(석재)에 거점을 짓는다.
    s.players.p1.resources = bundle(1, 0, 1);
    act(s, 'p1', { type: 'build', tileId: 'B4' });
    expect(s.players.p1.resources).toEqual(bundle(0, 0, 0));
    for (const p of ['p1', 'p2', 'p3']) act(s, p, { type: 'end_turn' });
    // 2라운드 예보 곡물: A3 목재 +1, B4 석재 +1
    expect(FORECAST[1]).toBe('grain');
    expect(s.players.p1.resources).toEqual(bundle(1, 0, 1));
  });

  it('6라운드가 끝나면 게임이 끝난다', () => {
    const s = setup3();
    for (let r = 1; r <= 6; r++) {
      expect(s.round).toBe(r);
      const n = s.order.length;
      for (let i = 0; i < n; i++) act(s, currentPlayer(s)!, { type: 'end_turn' });
    }
    expect(s.phase).toBe('finished');
    expect(s.result).not.toBeNull();
    expectFail(s, 'p1', { type: 'end_turn' }, 'WRONG_PHASE');
  });
});

describe('거점 건설', () => {
  it('목재 1·석재 1, 내 거점과 변을 맞댄 빈 생산 칸(최대 6칸), 최대 3개', () => {
    const s = setup3(['C2', 'A3', 'E3']);
    s.players.p1.resources = bundle(5, 0, 5);
    // C2 의 이웃: B1 B2 C1 C3(시장) D1 D2
    expect(buildableTiles(s.settlements, 'p1').sort()).toEqual(['B1', 'B2', 'C1', 'D1', 'D2']);
    expectFail(s, 'p1', { type: 'build', tileId: 'C3' }, 'TILE_INVALID'); // 시장
    expectFail(s, 'p1', { type: 'build', tileId: 'A2' }, 'NOT_ADJACENT'); // 두 칸 떨어진 칸
    act(s, 'p1', { type: 'build', tileId: 'B1' });
    act(s, 'p1', { type: 'build', tileId: 'A1' }); // 새 거점(B1)에 붙여 짓기
    act(s, 'p1', { type: 'end_turn' });
    act(s, 'p2', { type: 'end_turn' });
    act(s, 'p3', { type: 'end_turn' });
    act(s, 'p2', { type: 'end_turn' });
    act(s, 'p3', { type: 'end_turn' });
    s.players.p1.resources = bundle(5, 0, 5);
    expectFail(s, 'p1', { type: 'build', tileId: 'D1' }, 'LIMIT');
  });

  it('비용이 부족하거나 차례가 아니면 거절한다', () => {
    const s = setup3();
    s.players.p1.resources = bundle(1, 3, 0);
    expectFail(s, 'p1', { type: 'build', tileId: 'A2' }, 'NOT_ENOUGH');
    expectFail(s, 'p2', { type: 'build', tileId: 'B3' }, 'NOT_YOUR_TURN');
  });

  it('다른 사람 거점이 있는 칸에는 지을 수 없다', () => {
    const s = setup3(['A3', 'A2', 'E1']);
    s.players.p1.resources = bundle(5, 0, 5);
    expectFail(s, 'p1', { type: 'build', tileId: 'A2' }, 'TILE_TAKEN');
  });
});

describe('시장과 납품', () => {
  it('같은 종류 2개 → 다른 종류 1개, 위치와 무관', () => {
    const s = setup3(['D2', 'D4', 'E1']);
    s.players.p1.resources = bundle(2, 0, 0);
    expectFail(s, 'p1', { type: 'market', give: 'wood', get: 'wood' }, 'BAD_REQUEST');
    act(s, 'p1', { type: 'market', give: 'wood', get: 'grain' });
    expect(s.players.p1.resources).toEqual(bundle(0, 1, 0));
    expectFail(s, 'p1', { type: 'market', give: 'grain', get: 'wood' }, 'NOT_ENOUGH');
  });

  it('완료한 계약은 그 라운드 동안 모두에게 마감되고 점수를 준다', () => {
    const s = setup3();
    s.players.p1.resources = bundle(1, 1, 1);
    act(s, 'p1', { type: 'deliver', contractId: 'general' });
    expect(s.players.p1.score).toBe(2);
    expect(s.players.p1.resources).toEqual(bundle(0, 0, 0));
    act(s, 'p1', { type: 'end_turn' });
    s.players.p2.resources = bundle(3, 3, 3);
    expectFail(s, 'p2', { type: 'deliver', contractId: 'general' }, 'CONTRACT_CLOSED');
    for (const c of CONTRACTS.filter((c) => c.id !== 'general').slice(0, 2)) act(s, 'p2', { type: 'deliver', contractId: c.id });
    expect(s.players.p2.score).toBe(4);
  });
});

describe('플레이어 교환', () => {
  it('제안 → 수락 시 양쪽 자원이 옮겨지고 차례인 사람의 행동 1회를 쓴다', () => {
    const s = setup3(); // p1 3/1/1, p2 1/1/2
    act(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle(2, 0, 0), get: bundle(0, 0, 1) });
    expect(s.actionsLeft).toBe(2); // 제안만으로는 행동을 쓰지 않는다
    const id = s.trade!.id;
    act(s, 'p2', { type: 'trade_accept', tradeId: id });
    expect(s.players.p1.resources).toEqual(bundle(1, 1, 2));
    expect(s.players.p2.resources).toEqual(bundle(3, 1, 1));
    expect(s.actionsLeft).toBe(1);
    expect(s.trade).toBeNull();
  });

  it('같은 제안을 두 번 수락해도 자원은 한 번만 옮겨진다', () => {
    const s = setup3();
    act(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle(1, 0, 0), get: bundle(0, 1, 0) });
    const id = s.trade!.id;
    act(s, 'p2', { type: 'trade_accept', tradeId: id });
    const snapshot = JSON.stringify(s.players);
    const r = applyAction(s, 'p2', { type: 'trade_accept', tradeId: id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('TRADE_GONE');
    expect(JSON.stringify(s.players)).toBe(snapshot);
    expect(s.actionsLeft).toBe(1);
  });

  it('양쪽 모두 자원을 내야 하고, 같은 종류를 양쪽에 둘 수 없다', () => {
    const s = setup3();
    expectFail(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle(1, 0, 0), get: bundle(0, 0, 0) }, 'TRADE_INVALID');
    expectFail(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle(0, 0, 0), get: bundle(1, 0, 0) }, 'TRADE_INVALID');
    expectFail(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle(1, 1, 0), get: bundle(1, 0, 0) }, 'TRADE_INVALID');
    expectFail(s, 'p1', { type: 'trade_propose', to: 'p1', give: bundle(1, 0, 0), get: bundle(0, 1, 0) }, 'TRADE_INVALID');
    // 참가자가 아닌 이름(객체 기본 속성 이름 포함)으로는 제안할 수 없다.
    for (const to of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nobody']) {
      expectFail(s, 'p1', { type: 'trade_propose', to, give: bundle(1, 0, 0), get: bundle(0, 1, 0) }, 'TRADE_INVALID');
    }
    expectFail(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle(5, 0, 0), get: bundle(0, 1, 0) }, 'NOT_ENOUGH');
    expectFail(s, 'p2', { type: 'trade_propose', to: 'p1', give: bundle(1, 0, 0), get: bundle(0, 1, 0) }, 'NOT_YOUR_TURN');
  });

  it('제안은 한 번에 하나, 거절·취소는 행동을 쓰지 않는다, 대상만 수락·거절한다', () => {
    const s = setup3();
    act(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle(1, 0, 0), get: bundle(0, 1, 0) });
    expectFail(s, 'p1', { type: 'trade_propose', to: 'p3', give: bundle(1, 0, 0), get: bundle(0, 1, 0) }, 'TRADE_OPEN');
    const id = s.trade!.id;
    expect(applyAction(s, 'p3', { type: 'trade_accept', tradeId: id }).ok).toBe(false);
    expect(applyAction(s, 'p3', { type: 'trade_reject', tradeId: id }).ok).toBe(false);
    act(s, 'p2', { type: 'trade_reject', tradeId: id });
    expect(s.trade).toBeNull();
    expect(s.actionsLeft).toBe(2);
    act(s, 'p1', { type: 'trade_propose', to: 'p3', give: bundle(1, 0, 0), get: bundle(0, 1, 0) });
    expect(applyAction(s, 'p3', { type: 'trade_cancel', tradeId: s.trade!.id }).ok).toBe(false);
    act(s, 'p1', { type: 'trade_cancel', tradeId: s.trade!.id });
    expect(s.trade).toBeNull();
    expect(s.actionsLeft).toBe(2);
  });

  it('턴을 넘기면 제안이 닫힌다', () => {
    const s = setup3();
    act(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle(1, 0, 0), get: bundle(0, 1, 0) });
    const id = s.trade!.id;
    act(s, 'p1', { type: 'end_turn' });
    expect(s.trade).toBeNull();
    expect(applyAction(s, 'p2', { type: 'trade_accept', tradeId: id }).ok).toBe(false);
    expect(s.events.some((e) => e.kind === 'trade_closed' && e.reason === 'turn_end')).toBe(true);
  });

  it('받는 사람이 자원이 부족하면 수락할 수 없고 제안은 남는다', () => {
    const s = setup3(); // p2 곡물 1개
    act(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle(1, 0, 0), get: bundle(0, 3, 0) });
    const r = applyAction(s, 'p2', { type: 'trade_accept', tradeId: s.trade!.id });
    expect(r.ok).toBe(false);
    expect(s.trade).not.toBeNull();
  });

  it('제안한 사람이 자원을 써 버리거나 행동을 다 쓰면 제안이 닫힌다', () => {
    const s = setup3(); // p1 3/1/1
    act(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle(2, 0, 0), get: bundle(0, 0, 1) });
    act(s, 'p1', { type: 'market', give: 'wood', get: 'grain' }); // 목재 1개 남음
    expect(s.trade).toBeNull();
    expect(s.events.at(-1)).toMatchObject({ kind: 'trade_closed', reason: 'unaffordable' });

    act(s, 'p1', { type: 'trade_propose', to: 'p2', give: bundle(0, 1, 0), get: bundle(0, 0, 1) });
    act(s, 'p1', { type: 'market', give: 'grain', get: 'stone' }); // 곡물 2 → 0, 마지막 행동
    expect(s.actionsLeft).toBe(0);
    expect(s.trade).toBeNull();
  });
});

describe('결과', () => {
  const players = (spec: Record<string, [number, Bundle]>) =>
    Object.fromEntries(Object.entries(spec).map(([id, [score, resources]]) => [id, { id, score, resources }]));

  it('점수가 가장 높은 사람이 이긴다', () => {
    const r = computeResult({ order: ['a', 'b', 'c'], players: players({ a: [4, bundle()], b: [6, bundle()], c: [2, bundle(9, 9, 9)] }) });
    expect(r.winners).toEqual(['b']);
    expect(r.decidedBy).toBe('score');
    expect(r.ranking.map((e) => [e.playerId, e.rank])).toEqual([
      ['b', 1],
      ['a', 2],
      ['c', 3],
    ]);
  });

  it('점수가 같으면 남은 자원 총량, 그것도 같으면 공동 승리', () => {
    const tie = computeResult({ order: ['a', 'b', 'c'], players: players({ a: [6, bundle(1, 0, 0)], b: [6, bundle(1, 1, 0)], c: [2, bundle()] }) });
    expect(tie.winners).toEqual(['b']);
    expect(tie.decidedBy).toBe('resources');
    const joint = computeResult({
      order: ['a', 'b', 'c', 'd'],
      players: players({ a: [6, bundle(1, 1, 0)], b: [6, bundle(0, 0, 2)], c: [2, bundle()], d: [6, bundle(1, 0, 0)] }),
    });
    expect(joint.winners.sort()).toEqual(['a', 'b']);
    expect(joint.decidedBy).toBe('joint');
    expect(joint.ranking.find((e) => e.playerId === 'd')!.rank).toBe(3);
  });

  it('자원 총량은 남은 자원의 합이다', () => {
    const s = setup3();
    s.players.p1.resources = bundle(2, 3, 4);
    expect(computeResult(s).ranking.find((e) => e.playerId === 'p1')!.resourceTotal).toBe(bundleTotal(bundle(2, 3, 4)));
    expect(Object.keys(TILE_MAP)).toHaveLength(19);
  });
});

describe('육각 보드', () => {
  it('19칸, 줄마다 3-4-5-4-3칸, 가운데 시장, 목재·곡물·석재 6칸씩', () => {
    const rows = ['A', 'B', 'C', 'D', 'E'].map((r) => Object.keys(TILE_MAP).filter((id) => id.startsWith(r)).length);
    expect(rows).toEqual([3, 4, 5, 4, 3]);
    expect(TILE_MAP.C3.kind).toBe('market');
    expect(TILE_MAP.C3.q).toBe(0);
    expect(TILE_MAP.C3.r).toBe(0);
    const count = (k: string) => Object.values(TILE_MAP).filter((t) => t.kind === k).length;
    expect([count('wood'), count('grain'), count('stone'), count('market')]).toEqual([6, 6, 6, 1]);
  });

  it('이웃은 변을 맞댄 칸: 가운데 6칸, 꼭짓점 칸 3칸, 같은 종류 생산 칸끼리는 붙지 않는다', () => {
    expect([...NEIGHBORS.C3].sort()).toEqual(['B2', 'B3', 'C2', 'C4', 'D2', 'D3']);
    expect([...NEIGHBORS.A1].sort()).toEqual(['A2', 'B1', 'B2']);
    expect([...NEIGHBORS.C1].sort()).toEqual(['B1', 'C2', 'D1']);
    for (const [id, list] of Object.entries(NEIGHBORS)) {
      for (const n of list) {
        expect(NEIGHBORS[n]).toContain(id); // 대칭
        if (TILE_MAP[id].kind !== 'market') expect(TILE_MAP[n].kind, `${id}-${n}`).not.toBe(TILE_MAP[id].kind);
      }
    }
  });
});
