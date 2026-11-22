// 자원 카드(은행)와 발전 카드 장수 설정, 방장의 방 닫기
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boardOf } from '../src/shared/board';
import { DEV_DECK, PIECE_COST, RESOURCES, bundleTotal, devDeckFor, emptyBundle } from '../src/shared/constants';
import type { SessionInfo } from '../src/shared/protocol';
import { applyAction, autoPlay, bankTradeProblem, buildableRoads, createGame, placeableVertices, settleProduction, tradeRatios, type GameState } from '../src/shared/rules';
import type { Bundle, DevKind } from '../src/shared/types';
import { startServer, type RunningServer } from '../src/server/app';
import { RoomManager, isRoomError } from '../src/server/rooms';
import { TestClient, startedRoom } from './helpers';

const noShuffle = () => 0.999999;

/** 은행과 모든 손에 든 자원 수의 합 (자원마다) */
function totalCards(s: GameState): Bundle {
  const out = { ...s.bank! };
  for (const id of s.order) for (const r of RESOURCES) out[r] += s.players[id].resources[r];
  return out;
}

/** 손에 든 자원을 hand 로 맞춘다. 늘거나 준 만큼 은행과 주고받아 총 장수는 그대로다. */
function setHand(s: GameState, id: string, hand: Bundle): void {
  for (const r of RESOURCES) {
    s.bank![r] += s.players[id].resources[r] - hand[r];
    s.players[id].resources[r] = hand[r];
  }
}

/** 두 사람이 시작 배치를 마치고 첫 턴의 굴리기 단계에 있는 게임 */
function playing(opts: Parameters<typeof createGame>[2] = {}): GameState {
  const s = createGame(['a', 'b'], noShuffle, opts);
  for (const p of ['a', 'b', 'b', 'a']) {
    const v = placeableVertices(boardOf(s), s.buildings)[0];
    const e = boardOf(s).vertexMap[v].edges.find((id) => !s.roads.some((r) => r.edgeId === id))!;
    const res = applyAction(s, p, { type: 'place', vertexId: v, edgeId: e }, () => 0);
    if (!res.ok) throw new Error(res.message);
  }
  return s;
}

describe('발전 카드 장수', () => {
  it('25장이면 기본 구성 그대로이고, 다른 장수도 비율을 따라 나누며 종류마다 1장 이상 넣는다', () => {
    expect(devDeckFor(25)).toEqual(DEV_DECK);
    for (let total = 10; total <= 50; total++) {
      const deck = devDeckFor(total);
      expect(Object.values(deck).reduce((n, v) => n + v, 0)).toBe(total);
      for (const k of Object.keys(DEV_DECK) as DevKind[]) expect(deck[k]).toBeGreaterThanOrEqual(1);
      // 기사가 가장 많고 승점이 그다음이다.
      expect(deck.knight).toBeGreaterThan(deck.victory);
    }
    expect(devDeckFor(10)).toEqual({ knight: 5, victory: 2, road_building: 1, year_of_plenty: 1, monopoly: 1 });
  });

  it('정한 장수로 더미를 만들고, 범위를 벗어나면 게임을 열지 않는다', () => {
    const s = createGame(['a', 'b'], Math.random, { devCards: 40 });
    expect(s.devDeck).toHaveLength(40);
    expect(s.devDeck.filter((k) => k === 'knight')).toHaveLength(devDeckFor(40).knight);
    expect(() => createGame(['a', 'b'], Math.random, { devCards: 9 })).toThrow();
    expect(() => createGame(['a', 'b'], Math.random, { devCards: 51 })).toThrow();
  });
});

describe('은행 자원 카드', () => {
  it('은행은 자원마다 정한 장수로 시작하고, 범위를 벗어나면 게임을 열지 않는다', () => {
    const s = createGame(['a', 'b'], Math.random, { resourceCards: 24 });
    expect(s.bank).toEqual({ wood: 24, grain: 24, wool: 24, brick: 24, stone: 24 });
    expect(s.bankSize).toBe(24);
    expect(createGame(['a', 'b']).bank!.wood).toBe(19);
    expect(() => createGame(['a', 'b'], Math.random, { resourceCards: 9 })).toThrow();
    expect(() => createGame(['a', 'b'], Math.random, { resourceCards: 41 })).toThrow();
  });

  it('시작 마을 자원, 생산, 7 버리기를 거치며 오래 진행해도 카드 총 장수가 그대로다', () => {
    const random = (() => {
      let a = 7;
      return () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
    })();
    const s = createGame(['a', 'b', 'c'], random, { resourceCards: 12 });
    for (let i = 0; i < 500 && s.phase !== 'finished'; i++) autoPlay(s, random);
    expect(totalCards(s)).toEqual({ wood: 12, grain: 12, wool: 12, brick: 12, stone: 12 });
    expect(RESOURCES.every((r) => s.bank![r] >= 0)).toBe(true);
    // 은행이 작아 생산하지 못한 굴림이 한 번 이상 나온다.
    expect(s.events.some((e) => e.kind === 'roll' && e.short?.length)).toBe(true);
  });

  it('한 자원을 여러 사람이 받아야 하는데 은행이 모자라면 아무도 받지 못하고, 한 사람뿐이면 남은 만큼 받는다', () => {
    const owe = (a: number, b: number): Record<string, Bundle> => ({ a: { ...emptyBundle(), grain: a }, b: { ...emptyBundle(), grain: b } });
    const bank = { ...emptyBundle(), grain: 2, wood: 5 };
    expect(settleProduction(bank, owe(1, 1))).toEqual({ paid: owe(1, 1), short: [] });
    expect(settleProduction(bank, owe(2, 1))).toEqual({ paid: owe(0, 0), short: ['grain'] });
    expect(settleProduction(bank, owe(3, 0))).toEqual({ paid: owe(2, 0), short: ['grain'] });
    expect(settleProduction(null, owe(30, 30))).toEqual({ paid: owe(30, 30), short: [] });
  });

  it('건설 비용과 발전 카드 값은 은행으로 돌아간다', () => {
    const s = playing();
    s.step = 'main';
    const me = s.order[s.current];
    setHand(s, me, { wood: 2, grain: 2, wool: 2, brick: 2, stone: 2 });
    const before = { ...s.bank! };
    const res = applyAction(s, me, { type: 'buy_dev' }, () => 0);
    expect(res.ok).toBe(true);
    expect(s.bank!.grain).toBe(before.grain + 1);
    expect(s.bank!.wool).toBe(before.wool + 1);
    expect(s.bank!.stone).toBe(before.stone + 1);
    const edge = buildableRoads(boardOf(s), s.buildings, s.roads, me)[0];
    expect(applyAction(s, me, { type: 'build_road', edgeId: edge }).ok).toBe(true);
    expect(s.bank!.wood).toBe(before.wood + PIECE_COST.road.wood);
    expect(totalCards(s)).toEqual({ wood: 19, grain: 19, wool: 19, brick: 19, stone: 19 });
  });

  it('은행에 없는 자원은 은행 교환이나 풍년으로 받을 수 없다', () => {
    const s = playing();
    s.step = 'main';
    const me = s.order[s.current];
    setHand(s, me, { ...emptyBundle(), wood: 4 });
    const woodBefore = s.bank!.wood;
    const stoneTaken = s.bank!.stone;
    s.bank!.stone = 0;
    const ratio = tradeRatios(s, me).wood;
    const give = { ...emptyBundle(), wood: ratio };
    const get = { ...emptyBundle(), stone: 1 };
    expect(bankTradeProblem(give, get, tradeRatios(s, me), s.players[me].resources, s.bank)).toBe('은행에 석재이(가) 0장밖에 없습니다.');
    expect(applyAction(s, me, { type: 'bank_trade', give, get }).ok).toBe(false);
    expect(applyAction(s, me, { type: 'bank_trade', give, get: { ...emptyBundle(), brick: 1 } }).ok).toBe(true);
    expect(s.bank!.wood).toBe(woodBefore + ratio);

    s.players[me].devCards.push({ kind: 'year_of_plenty', boughtTurn: 0 });
    s.turn = 2;
    expect(applyAction(s, me, { type: 'play_dev', kind: 'year_of_plenty', resources: ['stone', 'grain'] }).ok).toBe(false);
    expect(s.players[me].devCards).toHaveLength(1);
    expect(applyAction(s, me, { type: 'play_dev', kind: 'year_of_plenty', resources: ['grain', 'grain'] }).ok).toBe(true);
    expect(s.players[me].resources.grain).toBe(2);
    expect(bundleTotal(totalCards(s))).toBe(19 * 5 - stoneTaken);
  });
});

describe('방 설정과 방 닫기', () => {
  let server: RunningServer;
  let url: string;
  beforeAll(async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', clientDir: null });
    url = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    await server.close();
  });

  it('방장이 카드 장수를 정하면 그 장수로 게임을 연다', () => {
    const m = new RoomManager();
    const made = m.create('방장');
    if (isRoomError(made)) throw new Error(made.error);
    const { room, player } = made;
    expect([room.resourceCards, room.devCards]).toEqual([19, 25]);
    expect(m.setSettings(room, player.id, { resourceCards: 30, devCards: 60 })).not.toBeNull();
    expect([room.resourceCards, room.devCards]).toEqual([19, 25]);
    expect(m.setSettings(room, player.id, { resourceCards: 30, devCards: 34 })).toBeNull();
    const joined = m.join(room.code, '손님');
    if (isRoomError(joined)) throw new Error(joined.error);
    for (const p of room.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(room, player.id)).toBeNull();
    expect(room.game!.bankSize).toBe(30);
    expect(room.game!.devDeck).toHaveLength(34);
    m.stopAllClocks();
  });

  it('방장만 방을 닫고, 닫으면 남은 사람에게 알린 뒤 방이 사라진다', async () => {
    const { clients, code } = await startedRoom(url, 3);
    const [host, ...guests] = clients;
    expect(await guests[0].emit('room:close', {})).toMatchObject({ ok: false });
    const notified = guests.map((g) => g.waitEvent('room:closed'));
    expect(await host.emit('room:close', {})).toEqual({ ok: true });
    await Promise.all(notified);
    expect(await host.emit('room:peek', { code })).toMatchObject({ ok: false });
    const late = new TestClient(url);
    await late.connected();
    expect(await late.emit('room:join', { code, nickname: '늦게' })).toMatchObject({ ok: false });
    for (const c of [...clients, late]) c.close();
  });

  it('대기실에서도 방장이 닫을 수 있다', async () => {
    const host = new TestClient(url);
    await host.connected();
    const created = await host.emit<SessionInfo>('room:create', { nickname: '방장' });
    if (!created.ok) throw new Error(created.error);
    host.session = created;
    expect(await host.emit('room:close', {})).toEqual({ ok: true });
    expect(await host.emit('room:peek', { code: created.roomCode })).toMatchObject({ ok: false });
    host.close();
  });
});
