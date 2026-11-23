import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERTICES } from '../src/shared/board';
import { RESOURCES, WIN_POINTS, bundleTotal, emptyBundle } from '../src/shared/constants';
import type { RoomListing, RoomView, SessionInfo } from '../src/shared/protocol';
import type { Bundle, GameEvent } from '../src/shared/types';
import { startServer, type RunningServer } from '../src/server/app';
import { isLoopbackAddress } from '../src/server/net';
import { TestClient, byId, chooseAction, startedRoom, sync } from './helpers';

let server: RunningServer;
let url: string;

beforeAll(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', clientDir: null });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

/** 한 판을 끝까지(누군가 10점) 진행한다. 세 턴에 한 번은 주사위를 굴린 뒤 다음 사람에게 교환을 제안해 교환 흐름도 함께 확인한다. */
async function playToEnd(clients: TestClient[]): Promise<{ trades: number; rejects: number; actions: number; turns: number }> {
  let trades = 0;
  let rejects = 0;
  let actions = 0;
  const tradedTurn = new Set<number>();
  for (let step = 0; step < 20000; step++) {
    const g = clients[0].latest!.game!;
    if (g.phase === 'finished') return { trades, rejects, actions, turns: g.turn };
    const turnId =
      g.phase === 'placement' ? g.placementPlayerId : g.step === 'discard' ? (Object.keys(g.discards)[0] ?? g.currentPlayerId) : g.currentPlayerId;
    const actor = byId(clients, turnId);
    const v = actor.latest!;
    const ag = v.game!;
    const seat = ag.order.indexOf(actor.id);

    if (ag.phase === 'playing' && ag.step === 'main' && ag.turn % 3 === 0 && !ag.trades.length && !tradedTurn.has(ag.turn) && ag.currentPlayerId === actor.id) {
      tradedTurn.add(ag.turn);
      const r = ag.myResources;
      const give = RESOURCES.find((x) => r[x] > 0);
      if (give) {
        const want = RESOURCES.find((x) => x !== give)!;
        const giveB: Bundle = { ...emptyBundle(), [give]: 1 };
        const getB: Bundle = { ...emptyBundle(), [want]: 1 };
        // 모두에게 제안하고 받은 사람은 낼 자원이 있으면 수락·없으면 거절한다.
        const res = await actor.act({ type: 'trade_propose', give: giveB, get: getB });
        expect(res).toEqual({ ok: true });
        await sync(clients, actor.latest!.game!.version);
        const tradeId = actor.latest!.game!.trades[0].id;
        const others = clients.filter((c) => c !== actor);
        let accepted: TestClient | null = null;
        for (const o of others) {
          const ov = o.latest!.game!;
          // 열린 제안 내용은 모두에게 보인다
          expect(ov.trades).toHaveLength(1);
          expect(ov.trades[0]).toMatchObject({ id: tradeId, from: actor.id, give: giveB, get: getB });
          if (ov.myResources[want] >= 1) {
            expect(await o.act({ type: 'trade_accept', tradeId })).toEqual({ ok: true });
            accepted ??= o;
          } else expect(await o.act({ type: 'trade_reject', tradeId })).toEqual({ ok: true });
          await sync(clients, o.latest!.game!.version);
        }
        if (accepted) {
          const before = { a: { ...actor.latest!.game!.myResources }, t: { ...accepted.latest!.game!.myResources } };
          expect(actor.latest!.game!.trades[0].responses[accepted.id]).toBe('accepted');
          expect(await actor.act({ type: 'trade_confirm', tradeId, with: accepted.id })).toEqual({ ok: true });
          await sync(clients, actor.latest!.game!.version);
          expect(actor.latest!.game!.trades).toEqual([]);
          expect(actor.latest!.game!.myResources[give]).toBe(before.a[give] - 1);
          expect(actor.latest!.game!.myResources[want]).toBe(before.a[want] + 1);
          expect(accepted.latest!.game!.myResources[give]).toBe(before.t[give] + 1);
          expect(accepted.latest!.game!.myResources[want]).toBe(before.t[want] - 1);
          trades++;
        } else {
          // 모두 거절하면 제안이 저절로 닫힌다
          expect(actor.latest!.game!.trades).toEqual([]);
          rejects++;
        }
        continue;
      }
    }

    const action = chooseAction(v, seat);
    const res = await actor.act(action);
    expect(res, `${action.type} by ${actor.session!.nickname} (${ag.step})`).toEqual({ ok: true });
    actions++;
    await sync(clients, actor.latest!.game!.version);
  }
  throw new Error('게임이 끝나지 않았습니다.');
}

/** 각 참가자가 받은 모든 메시지에 다른 사람의 비공개 정보가 없는지 확인한다. */
function assertPrivacy(clients: TestClient[]): void {
  for (const c of clients) {
    const me = c.id;
    const otherTokens = clients.filter((o) => o !== c).map((o) => o.session!.token);
    for (const msg of c.received) {
      const text = JSON.stringify(msg.args);
      for (const t of otherTokens) expect(text.includes(t)).toBe(false);
      if (msg.event !== 'state') continue;
      const view = msg.args[0] as RoomView;
      expect(view.you).toBe(me);
      const g = view.game;
      if (!g) continue;
      for (const p of g.players)
        expect(Object.keys(p).sort()).toEqual(['cities', 'devCardCount', 'id', 'knightsPlayed', 'resourceTotal', 'roadLength', 'roads', 'score', 'seat', 'villages']);
      // 열린 교환 제안은 내용과 응답만 공개하고 누구의 종류별 보유량도 담지 않는다.
      for (const t of g.trades) expect(Object.keys(t).sort()).toEqual(['from', 'get', 'give', 'id', 'responses', 'to']);
      for (const e of g.events as GameEvent[]) {
        if ((e.kind === 'discard' || e.kind === 'buy_dev') && e.player !== me) expect(e.detail).toBeUndefined();
        if (e.kind === 'steal' && e.player !== me && e.from !== me) expect(e.detail).toBeUndefined();
        if (e.kind.startsWith('trade_')) expect(e).not.toHaveProperty('detail');
        if (e.kind === 'roll' && e.detail) expect(Object.keys(e.detail)).toEqual([me]);
      }
    }
  }
}

function assertSameResult(clients: TestClient[]): void {
  const results = clients.map((c) => JSON.stringify(c.latest!.game!.result));
  expect(new Set(results).size).toBe(1);
  const g = clients[0].latest!.game!;
  expect(g.phase).toBe('finished');
  const result = g.result!;
  // 이긴 사람은 10점 이상이고, 순위는 (이긴 사람 다음으로) 점수 → 남은 자원 순이며, 게임이 끝나면 공개된 점수와 맞아야 한다.
  expect(result.ranking[0].score).toBeGreaterThanOrEqual(WIN_POINTS);
  expect(result.winners).toEqual([result.ranking[0].playerId]);
  for (const e of result.ranking) {
    const p = g.players.find((x) => x.id === e.playerId)!;
    expect(e.score).toBe(p.score);
    expect(e.resourceTotal).toBe(p.resourceTotal);
  }
  for (let i = 2; i < result.ranking.length; i++) {
    const a = result.ranking[i - 1];
    const b = result.ranking[i];
    expect(a.score > b.score || (a.score === b.score && a.resourceTotal >= b.resourceTotal)).toBe(true);
  }
  // 각자 화면의 자원 합계는 공개 총량과 같아야 한다.
  for (const c of clients) {
    const mine = c.latest!.game!.myResources;
    expect(bundleTotal(mine)).toBe(g.players.find((p) => p.id === c.id)!.resourceTotal);
  }
}

/** 화면 정보에는 최근 기록만 들어 있으므로, 받은 모든 메시지에서 기록을 모은다. */
function allEvents(c: TestClient): GameEvent[] {
  const bySeq = new Map<number, GameEvent>();
  for (const msg of c.received) {
    if (msg.event !== 'state') continue;
    for (const e of ((msg.args[0] as RoomView).game?.events ?? []) as GameEvent[]) bySeq.set(e.seq, e);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function assertTurns(clients: TestClient[]): void {
  const g = clients[0].latest!.game!;
  const n = g.order.length;
  const events = allEvents(clients[0]);
  // 턴마다 주사위를 한 번 굴리고, 차례는 자리 순서대로 돈다.
  const rolls = events.filter((e): e is Extract<GameEvent, { kind: 'roll' }> => e.kind === 'roll');
  rolls.forEach((e, i) => expect(e.player).toBe(g.order[i % n]));
  expect(rolls.length).toBe(g.turn);
  // 시작 배치는 자리 순서대로 한 바퀴, 거꾸로 한 바퀴
  const placements = events.filter((e) => e.kind === 'placement').map((e) => (e as { player: string }).player);
  expect(placements).toEqual([...g.order, ...[...g.order].reverse()]);
}

describe('한 판 완주', () => {
  for (const n of [3, 4]) {
    it(`${n}인: 시작 배치부터 10점 승리·순위까지 모든 화면이 일치한다`, async () => {
      const { clients } = await startedRoom(url, n);
      const stats = await playToEnd(clients);
      assertSameResult(clients);
      assertTurns(clients);
      assertPrivacy(clients);
      const g = clients[0].latest!.game!;
      expect(stats.trades + stats.rejects).toBeGreaterThan(0);
      console.log(
        `[${n}인] ${stats.turns}턴, 행동 ${stats.actions}회, 교환 성사 ${stats.trades}·거절 ${stats.rejects}, 결과: ${g.result!.ranking
          .map((e) => `${e.rank}위 ${clients.find((c) => c.id === e.playerId)!.session!.nickname} ${e.score}점/${e.resourceTotal}개`)
          .join(', ')} (${g.result!.decidedBy})`,
      );

      // 게임이 끝난 뒤 방장이 같은 멤버로 대기실을 다시 연다.
      expect(await clients[1].emit('room:rematch', {})).toMatchObject({ ok: false });
      expect(await clients[0].emit('room:rematch', {})).toEqual({ ok: true });
      for (const c of clients) {
        const v = await c.waitFor((x) => x.phase === 'lobby');
        expect(v.players).toHaveLength(n);
        expect(v.players.every((p) => !p.ready)).toBe(true);
        expect(v.gameNumber).toBe(2);
      }
      clients.forEach((c) => c.close());
    });
  }
});

/** 시작 배치를 끝내고 첫 턴(주사위 굴리기 전) 상태로 만든다. */
async function toFirstTurn(clients: TestClient[]): Promise<void> {
  for (let i = 0; i < clients.length * 2; i++) {
    const g = clients[0].latest!.game!;
    const actor = byId(clients, g.placementPlayerId);
    const res = await actor.act(chooseAction(actor.latest!, g.order.indexOf(actor.id)));
    expect(res).toEqual({ ok: true });
    await sync(clients, actor.latest!.game!.version);
  }
  expect(clients[0].latest!.game!.phase).toBe('playing');
}

/** 첫 턴 사람이 주사위를 굴리고 (7이면 버리기·동상까지 처리해) 교환·건설 단계로 만든다. */
async function toMainStep(clients: TestClient[]): Promise<void> {
  await toFirstTurn(clients);
  for (let i = 0; i < 20; i++) {
    const g = clients[0].latest!.game!;
    if (g.step === 'main') return;
    const who = g.step === 'discard' ? Object.keys(g.discards)[0] : g.currentPlayerId;
    const actor = byId(clients, who);
    expect(await actor.act(chooseAction(actor.latest!, g.order.indexOf(actor.id)))).toEqual({ ok: true });
    await sync(clients, actor.latest!.game!.version);
  }
  throw new Error('교환·건설 단계로 가지 못했습니다.');
}

describe('교환 수락은 한 번만 반영', () => {
  it('같은 제안을 동시에 두 번 수락·확정해도 자원은 한 번만 옮겨진다', async () => {
    const { clients } = await startedRoom(url, 3);
    await toMainStep(clients);
    const g = clients[0].latest!.game!;
    const actor = byId(clients, g.currentPlayerId);
    const target = byId(clients, g.order[(g.order.indexOf(actor.id) + 1) % 3]);
    const a0 = { ...actor.latest!.game!.myResources };
    const t0 = { ...target.latest!.game!.myResources };
    // 시작 마을로 받은 자원이 있으므로 두 사람 모두 낼 자원이 있다. 없으면 이 판에서는 확인할 수 없어 건너뛴다.
    const give = RESOURCES.find((r) => a0[r] > 0);
    const want = RESOURCES.find((r) => r !== give && t0[r] > 0 && a0[r] === 0) ?? RESOURCES.find((r) => r !== give && t0[r] > 0);
    if (!give || !want) {
      clients.forEach((c) => c.close());
      return;
    }
    const giveB: Bundle = { ...emptyBundle(), [give]: 1 };
    const getB: Bundle = { ...emptyBundle(), [want]: 1 };
    expect(await actor.act({ type: 'trade_propose', give: giveB, get: getB })).toEqual({ ok: true });
    const tv = await target.waitFor((v) => v.game!.trades.length > 0);
    const tradeId = tv.game!.trades[0].id;

    // 서로 다른 요청 두 개를 동시에 보낸다 (버튼을 빠르게 두 번 누른 경우). 수락은 한 번만 기록된다.
    const [a1r, a2r] = await Promise.all([target.act({ type: 'trade_accept', tradeId }), target.act({ type: 'trade_accept', tradeId })]);
    expect([a1r, a2r].filter((r) => r.ok)).toHaveLength(1);
    expect([a1r, a2r].find((r) => !r.ok)).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
    // 수락만으로는 자원이 옮겨지지 않는다.
    await actor.waitFor((v) => v.game!.trades[0]?.responses[target.id] === 'accepted');
    expect(target.latest!.game!.myResources).toEqual(t0);

    // 제안한 사람이 확정을 두 번 동시에 보내도 한 번만 성공한다.
    const [r1, r2] = await Promise.all([
      actor.act({ type: 'trade_confirm', tradeId, with: target.id }),
      actor.act({ type: 'trade_confirm', tradeId, with: target.id }),
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    const failed = [r1, r2].find((r) => !r.ok);
    expect(failed).toMatchObject({ ok: false, code: 'TRADE_GONE' });

    // 같은 요청이 네트워크에서 다시 도착한 경우: 처음 결과를 돌려주고 다시 반영하지 않는다.
    const replay = await actor.act({ type: 'trade_confirm', tradeId, with: target.id }, 'same-request-id');
    const replay2 = await actor.act({ type: 'trade_confirm', tradeId, with: target.id }, 'same-request-id');
    expect(replay2).toEqual(replay);

    await sync(clients, Math.max(...clients.map((c) => c.latest!.game!.version)));
    const a1 = actor.latest!.game!.myResources;
    const t1 = target.latest!.game!.myResources;
    expect(a1[give]).toBe(a0[give] - 1);
    expect(a1[want]).toBe(a0[want] + 1);
    expect(t1[give]).toBe(t0[give] + 1);
    expect(t1[want]).toBe(t0[want] - 1);
    const accepted = actor.latest!.game!.events.filter((e) => e.kind === 'trade_accepted');
    expect(accepted).toHaveLength(1);
    assertPrivacy(clients);
    clients.forEach((c) => c.close());
  });

  it('같은 요청 ID로 다시 보낸 행동은 한 번만 처리된다', async () => {
    const { clients } = await startedRoom(url, 3);
    await toMainStep(clients);
    const g = clients[0].latest!.game!;
    const actor = byId(clients, g.currentPlayerId);
    const r1 = await actor.act({ type: 'end_turn' }, 'dup-end-turn');
    const r2 = await actor.act({ type: 'end_turn' }, 'dup-end-turn');
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    await sync(clients, actor.latest!.game!.version);
    const after = clients[0].latest!.game!;
    // 턴은 한 번만 넘어간다.
    expect(after.currentPlayerId).toBe(g.order[(g.order.indexOf(actor.id) + 1) % 3]);
    expect(after.events.filter((e) => e.kind === 'turn_end')).toHaveLength(1);
    clients.forEach((c) => c.close());
  });
});

describe('서버 판정', () => {
  it('차례가 아니거나 비용이 부족한 요청, 잘못된 형식의 요청을 거절하고 상태를 바꾸지 않는다', async () => {
    const { clients } = await startedRoom(url, 3);
    // 시작 배치 순서가 아닌 사람
    const g0 = clients[0].latest!.game!;
    const notPlacer = clients.find((c) => c.id !== g0.placementPlayerId)!;
    expect(await notPlacer.act({ type: 'place', vertexId: 'v13', edgeId: 'e12' })).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    await toFirstTurn(clients);
    const g = clients[0].latest!.game!;
    const version = g.version;
    const actor = byId(clients, g.currentPlayerId);
    const other = clients.find((c) => c !== actor)!;
    expect(await other.act({ type: 'end_turn' })).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(await other.act({ type: 'bank_trade', give: { ...emptyBundle(), wood: 4 }, get: { ...emptyBundle(), stone: 1 } })).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(await other.act({ type: 'roll' })).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    // 차례인 사람이라도 주사위를 굴리기 전에는 건설·턴 종료를 할 수 없다
    expect(await actor.act({ type: 'end_turn' })).toMatchObject({ ok: false, code: 'WRONG_STEP' });
    const empty = VERTICES.find((vx) => !g.buildings.some((b) => b.vertexId === vx.id))!.id;
    expect(await actor.act({ type: 'build_city', vertexId: empty })).toMatchObject({ ok: false, code: 'WRONG_STEP' });
    expect(await actor.act({ type: 'move_robber', tileId: 'A1' })).toMatchObject({ ok: false, code: 'WRONG_STEP' });
    // 형식이 잘못된 요청
    expect(await actor.emit('game:action', { requestId: 'bad-1', action: { type: 'build_road', edgeId: 'Z9' } })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(await actor.emit('game:action', { requestId: 'bad-2', action: { type: 'trade_propose', to: other.id, give: { wood: -1 }, get: { grain: 1 } } })).toMatchObject({
      ok: false,
      code: 'BAD_REQUEST',
    });
    expect(await actor.emit('game:action', { action: { type: 'end_turn' } })).toMatchObject({ ok: false });
    expect(await actor.emit('game:action', 'nonsense')).toMatchObject({ ok: false });
    expect(clients[0].latest!.game!.version).toBe(version);
    clients.forEach((c) => c.close());
  });
});

describe('대기실', () => {
  it('최대 4명, 닉네임 중복 불가, 방장만 시작, 모두 준비해야 시작, 내보내기와 방장 넘기기', async () => {
    const host = new TestClient(url);
    await host.connected();
    const created = await host.emit<SessionInfo>('room:create', { nickname: '  방장  ' });
    expect(created).toMatchObject({ ok: true, nickname: '방장' });
    if (!created.ok) return;
    host.session = created;
    const code = created.roomCode;
    expect((await host.emit('room:peek', { code: code.toLowerCase() })).ok).toBe(true);
    expect(await host.emit('room:join', { code: 'ZZZZ', nickname: 'x' })).toMatchObject({ ok: false });

    const guests: TestClient[] = [];
    for (const nick of ['둘', '셋', '넷']) {
      const c = new TestClient(url);
      await c.connected();
      const res = await c.emit<SessionInfo>('room:join', { code, nickname: nick });
      expect(res.ok).toBe(true);
      if (res.ok) c.session = res;
      guests.push(c);
    }
    const dup = new TestClient(url);
    await dup.connected();
    expect(await dup.emit('room:join', { code, nickname: '다섯' })).toMatchObject({ ok: false, code: 'FULL' });
    const kicked = guests[2].waitEvent('kicked');
    expect(await host.emit('room:kick', { playerId: guests[2].id })).toEqual({ ok: true });
    await kicked;
    expect(await dup.emit('room:join', { code, nickname: '둘' })).toMatchObject({ ok: false, code: 'NICK_TAKEN' });
    expect(await dup.emit('room:join', { code, nickname: '' })).toMatchObject({ ok: false });

    // 모두 준비 전에는 시작할 수 없고, 방장이 아니면 시작할 수 없다.
    expect(await host.emit('room:ready', { ready: true })).toEqual({ ok: true });
    expect(await host.emit('room:start', {})).toMatchObject({ ok: false });
    for (const c of guests.slice(0, 2)) expect(await c.emit('room:ready', { ready: true })).toEqual({ ok: true });
    expect(await guests[0].emit('room:start', {})).toMatchObject({ ok: false });

    // 방장이 나가면 다음 사람이 방장이 된다.
    expect(await host.emit('room:leave', {})).toEqual({ ok: true });
    const v = await guests[0].waitFor((x) => x.players.length === 2);
    expect(v.hostId).toBe(guests[0].id);
    expect(await guests[0].emit('room:start', {})).toEqual({ ok: true }); // 2명이면 일대일로 시작된다
    [host, dup, ...guests].forEach((c) => c.close());
  });
});

describe('방장 넘김과 빈 방 정리', () => {
  it('방장이 나가면 연결이 끊긴 사람이 아니라 접속해 있는 사람에게 방장이 넘어간다', async () => {
    const host = new TestClient(url);
    await host.connected();
    const created = await host.emit<SessionInfo>('room:create', { nickname: '방장' });
    if (!created.ok) throw new Error(created.error);
    host.session = created;
    const away = new TestClient(url);
    await away.connected();
    const a = await away.emit<SessionInfo>('room:join', { code: created.roomCode, nickname: '자리비움' });
    if (!a.ok) throw new Error(a.error);
    const here = new TestClient(url);
    await here.connected();
    const b = await here.emit<SessionInfo>('room:join', { code: created.roomCode, nickname: '여기있음' });
    if (!b.ok) throw new Error(b.error);
    here.session = b;
    away.close();
    await host.waitFor((v) => v.players.find((p) => p.id === a.playerId)?.connected === false);
    expect(await host.emit('room:leave', {})).toEqual({ ok: true });
    const v = await here.waitFor((x) => x.players.length === 2);
    expect(v.hostId).toBe(b.playerId);
    // 새 방장은 끊긴 사람을 내보낼 수 있다.
    expect(await here.emit('room:kick', { playerId: a.playerId })).toEqual({ ok: true });
    [host, here].forEach((c) => c.close());
  });

  it('혼자 있던 대기실에서 새 방을 만들거나 다른 방에 들어가면 이전 대기실은 닫힌다', async () => {
    const c = new TestClient(url);
    await c.connected();
    const first = await c.emit<SessionInfo>('room:create', { nickname: '혼자' });
    const second = await c.emit<SessionInfo>('room:create', { nickname: '혼자' });
    if (!first.ok || !second.ok) throw new Error('방 만들기 실패');
    expect(await c.emit('room:peek', { code: first.roomCode })).toMatchObject({ ok: false, code: 'NO_ROOM' });
    expect((await c.emit('room:peek', { code: second.roomCode })).ok).toBe(true);

    const other = new TestClient(url);
    await other.connected();
    const target = await other.emit<SessionInfo>('room:create', { nickname: '다른방' });
    if (!target.ok) throw new Error(target.error);
    expect((await c.emit('room:join', { code: target.roomCode, nickname: '혼자' })).ok).toBe(true);
    expect(await c.emit('room:peek', { code: second.roomCode })).toMatchObject({ ok: false, code: 'NO_ROOM' });
    // 다른 사람이 있는 대기실이나 게임 중인 방은 닫지 않는다.
    expect((await other.emit('room:peek', { code: target.roomCode })).ok).toBe(true);
    [c, other].forEach((x) => x.close());
  });
});

describe('재접속', () => {
  it('새로고침(연결 끊김) 뒤 참가 토큰으로 같은 자리와 최신 상태를 되찾고 게임을 이어 간다', async () => {
    const { clients, code } = await startedRoom(url, 3);
    await toFirstTurn(clients);
    const g = clients[0].latest!.game!;
    const actor = byId(clients, g.currentPlayerId);
    const watcher = clients.find((c) => c !== actor)!;
    const session = actor.session!;
    const resourcesBefore = { ...actor.latest!.game!.myResources };

    // 차례인 사람의 브라우저가 끊긴다 → 다른 사람 화면에 연결 끊김 표시, 게임은 그 사람을 기다린다.
    actor.close();
    const seen = await watcher.waitFor((v) => v.players.find((p) => p.id === session.playerId)?.connected === false);
    expect(seen.game!.currentPlayerId).toBe(session.playerId);

    // 기다리는 동안 다른 사람이 상태를 바꿀 수 없다.
    expect(await watcher.act({ type: 'end_turn' })).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });

    // 같은 토큰으로 다시 연결 (새로고침)
    const again = new TestClient(url, { roomCode: code, token: session.token });
    again.session = session;
    await again.connected();
    const restored = await again.waitFor((v) => v.phase === 'game');
    expect(restored.you).toBe(session.playerId);
    expect(restored.game!.currentPlayerId).toBe(session.playerId);
    expect(restored.game!.myResources).toEqual(resourcesBefore);
    expect(restored.game!.version).toBe(watcher.latest!.game!.version);
    await watcher.waitFor((v) => v.players.find((p) => p.id === session.playerId)?.connected === true);

    // 이어서 진행
    expect(await again.act({ type: 'roll' })).toEqual({ ok: true });
    await watcher.waitFor((v) => v.game!.events.some((e) => e.kind === 'roll' && e.player === session.playerId));
    clients[clients.indexOf(actor)] = again;
    assertPrivacy(clients.filter((c) => c !== actor));
    clients.forEach((c) => c.close());
  });

  it('같은 자리에 다른 탭이 붙으면 이전 탭은 연결이 넘어갔다는 알림을 받는다', async () => {
    const { clients, code } = await startedRoom(url, 3);
    const a = clients[1];
    const replaced = a.waitEvent('session:replaced');
    const b = new TestClient(url, { roomCode: code, token: a.session!.token });
    await b.connected();
    await replaced;
    const v = await b.waitFor((x) => x.phase === 'game');
    expect(v.you).toBe(a.id);
    // 넘겨준 쪽은 더 이상 그 자리로 행동할 수 없다.
    expect(await a.act({ type: 'end_turn' })).toMatchObject({ ok: false });
    [...clients, b].forEach((c) => c.close());
  });

  it('없는 방이나 잘못된 토큰이면 session:invalid 를 받는다', async () => {
    const c = new TestClient(url, { roomCode: 'ABCD', token: 'nope' });
    const [info] = (await c.waitEvent('session:invalid')) as [{ reason: string }];
    expect(info.reason).toMatch(/방을 찾을 수 없습니다/);
    c.close();
  });

  it('게임 시작 후에는 새 참가자를 받지 않는다', async () => {
    const { clients, code } = await startedRoom(url, 3);
    const late = new TestClient(url);
    await late.connected();
    expect(await late.emit('room:join', { code, nickname: '늦은사람' })).toMatchObject({ ok: false, code: 'STARTED' });
    [...clients, late].forEach((c) => c.close());
  });
});

describe('남은 방 정리 (서버를 켠 PC)', () => {
  it('남은 방 목록을 보고, 고른 방을 지우면 접속해 있던 사람에게 알리고 방이 사라진다', async () => {
    const { clients, code } = await startedRoom(url, 2);
    const lone = new TestClient(url);
    await lone.connected();
    const lobby = await lone.emit<SessionInfo>('room:create', { nickname: '혼자' });
    if (!lobby.ok) throw new Error(lobby.error);
    const admin = new TestClient(url);
    await admin.connected();

    const listed = await admin.emit<{ rooms: RoomListing[] }>('rooms:list', {});
    if (!listed.ok) throw new Error(listed.error);
    const game = listed.rooms.find((r) => r.code === code)!;
    expect(game).toMatchObject({ phase: 'game', finished: false, connected: 2 });
    expect(game.players).toHaveLength(2);
    expect(listed.rooms.find((r) => r.code === lobby.roomCode)).toMatchObject({ phase: 'lobby', players: ['혼자'], connected: 1 });

    const notified = [...clients, lone].map((c) => c.waitEvent('room:closed'));
    const res = await admin.emit<{ removed: string[] }>('rooms:remove', { codes: [code, lobby.roomCode.toLowerCase(), 'ZZZZ', 42] });
    expect(res).toEqual({ ok: true, removed: [code, lobby.roomCode] });
    const infos = await Promise.all(notified);
    for (const args of infos) expect(args[0]).toEqual({ by: 'server' });
    expect(await admin.emit('room:peek', { code })).toMatchObject({ ok: false });
    expect(await admin.emit('room:peek', { code: lobby.roomCode })).toMatchObject({ ok: false });
    const after = await admin.emit<{ rooms: RoomListing[] }>('rooms:list', {});
    if (!after.ok) throw new Error(after.error);
    expect(after.rooms.map((r) => r.code)).not.toContain(code);

    expect(await admin.emit('rooms:remove', { codes: 'all' })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    [...clients, lone, admin].forEach((c) => c.close());
  });

  it('이 PC 자신에서 온 연결만 서버를 켠 PC로 본다', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.1.1']) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ['192.168.30.141', '::ffff:192.168.0.5', '10.0.0.2', 'fe80::1', '', undefined]) expect(isLoopbackAddress(a)).toBe(false);
  });
});
