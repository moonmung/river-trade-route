// 통합 테스트용 도우미: 실제 서버를 띄우고 Socket.IO 클라이언트 여러 개로 참가한다.
import { io as connect, type Socket } from 'socket.io-client';
import { expect } from 'vitest';
import { VERTEX_MAP } from '../src/shared/board';
import { DEV_COST, PIECE_COST, PIECE_LIMIT, RESOURCES, TILES, hasBundle } from '../src/shared/constants';
import type { AckResult, RoomView, SessionInfo } from '../src/shared/protocol';
import { buildableRoads, buildableVillages, pieceCount, placeableVertices, setupRoadEdges, upgradableVillages } from '../src/shared/rules';
import type { GameAction } from '../src/shared/types';

export class TestClient {
  readonly socket: Socket;
  latest: RoomView | null = null;
  session: SessionInfo | null = null;
  /** 이 클라이언트가 받은 모든 메시지 (비공개 정보 검사용) */
  readonly received: { event: string; args: unknown[] }[] = [];
  private counter = 0;
  private waiters: (() => void)[] = [];

  constructor(url: string, auth: Record<string, string> = {}) {
    this.socket = connect(url, { forceNew: true, transports: ['websocket'], auth, reconnection: false });
    this.socket.onAny((event: string, ...args: unknown[]) => {
      this.received.push({ event, args });
      if (event === 'state') this.latest = args[0] as RoomView;
      const w = this.waiters;
      this.waiters = [];
      w.forEach((fn) => fn());
    });
  }

  get id(): string {
    return this.session!.playerId;
  }

  async connected(): Promise<void> {
    if (this.socket.connected) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once('connect', () => resolve());
      this.socket.once('connect_error', reject);
    });
  }

  async emit<T extends object = object>(event: string, payload: unknown): Promise<AckResult<T>> {
    return (await this.socket.timeout(5000).emitWithAck(event, payload)) as AckResult<T>;
  }

  async act(action: GameAction, requestId = `t-${Date.now()}-${++this.counter}`): Promise<AckResult> {
    return this.emit('game:action', { requestId, action });
  }

  /** 조건을 만족하는 화면 정보가 올 때까지 기다린다. */
  async waitFor(pred: (v: RoomView) => boolean, timeoutMs = 4000): Promise<RoomView> {
    const deadline = Date.now() + timeoutMs;
    while (!(this.latest && pred(this.latest))) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`상태를 기다리다 시간 초과 (${this.session?.nickname ?? '?'})`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    return this.latest!;
  }

  waitEvent(event: string, timeoutMs = 4000): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${event} 이벤트 시간 초과`)), timeoutMs);
      this.socket.once(event, (...args: unknown[]) => {
        clearTimeout(t);
        resolve(args);
      });
    });
  }

  close(): void {
    this.socket.disconnect();
  }
}

export const NAMES = ['강나루', '물레방아', '버들', '돌다리'];

/** 방을 만들고 n명이 참가·준비한 뒤 시작한다. */
export async function startedRoom(url: string, n: number): Promise<{ clients: TestClient[]; code: string }> {
  const host = new TestClient(url);
  await host.connected();
  const created = await host.emit<SessionInfo>('room:create', { nickname: NAMES[0] });
  if (!created.ok) throw new Error(created.error);
  host.session = created;
  const clients = [host];
  for (let i = 1; i < n; i++) {
    const c = new TestClient(url);
    await c.connected();
    const joined = await c.emit<SessionInfo>('room:join', { code: created.roomCode, nickname: NAMES[i] });
    if (!joined.ok) throw new Error(joined.error);
    c.session = joined;
    clients.push(c);
  }
  for (const c of clients) expect((await c.emit('room:ready', { ready: true })).ok).toBe(true);
  await host.waitFor((v) => v.players.length === n && v.players.every((p) => p.ready));
  const start = await host.emit('room:start', {});
  expect(start).toEqual({ ok: true });
  for (const c of clients) await c.waitFor((v) => v.phase === 'game');
  return { clients, code: created.roomCode };
}

export function byId(clients: TestClient[], id: string | null): TestClient {
  const c = clients.find((x) => x.id === id);
  if (!c) throw new Error(`플레이어 ${id} 없음`);
  return c;
}

/** 모든 참가자의 화면이 같은 버전이 될 때까지 기다린다. */
export async function sync(clients: TestClient[], version: number): Promise<void> {
  await Promise.all(clients.map((c) => c.waitFor((v) => (v.game?.version ?? 0) >= version)));
}

/**
 * 간단한 봇 (카탄 규칙). 굴리기 → (7이면 버리기·동상·빼앗기) → 도시 → 마을 → 발전 카드·길 → 모자란 자원 은행 교환 → 턴 종료.
 * 매 행동이 자원을 쓰거나 단계를 넘기므로 같은 턴에 끝없이 돌지 않는다.
 */
export function chooseAction(v: RoomView, seat: number): GameAction {
  const g = v.game!;
  const me = v.you;
  const r = g.myResources;
  if (g.phase === 'placement') {
    const free = placeableVertices(g.buildings);
    // 자리와 배치 횟수마다 다른 쪽에서 골라 마을이 고르게 퍼지게 한다. 바닷가보다 칸 셋에 닿은 꼭짓점을 먼저 본다.
    const inner = free.filter((id) => VERTEX_MAP[id].tiles.length === 3);
    const pool = inner.length ? inner : free;
    const vertexId = pool[(seat * 7 + g.buildings.length * 5) % pool.length];
    return { type: 'place', vertexId, edgeId: setupRoadEdges(g.roads, vertexId)[0] };
  }
  if (g.step === 'discard' && g.discards[me]) {
    // 가장 많은 자원부터 하나씩 버린다
    const left = { ...r };
    const out = { wood: 0, grain: 0, wool: 0, brick: 0, stone: 0 };
    for (let i = 0; i < g.discards[me]; i++) {
      const most = RESOURCES.reduce((a, b) => (left[a] >= left[b] ? a : b));
      left[most] -= 1;
      out[most] += 1;
    }
    return { type: 'discard', bundle: out };
  }
  if (g.step === 'roll') return { type: 'roll' };
  if (g.step === 'robber') {
    // 남의 마을이 많이 닿고 내 마을은 없는 칸
    const score = (tileId: string) =>
      g.buildings.filter((b) => VERTEX_MAP[b.vertexId].tiles.includes(tileId)).reduce((n, b) => n + (b.owner === me ? -10 : 1), 0);
    const tiles = TILES.map((t) => t.id).filter((id) => id !== g.robber);
    const best = tiles.reduce((a, b) => (score(b) > score(a) ? b : a), tiles[(seat * 5) % tiles.length]);
    return { type: 'move_robber', tileId: best };
  }
  if (g.step === 'steal') return { type: 'steal', from: g.stealFrom[0] };
  if (g.step === 'road_building') return { type: 'build_road', edgeId: buildableRoads(g.buildings, g.roads, me)[0] };

  const count = (kind: 'road' | 'village' | 'city') => pieceCount(g.buildings, g.roads, me, kind);
  const playable = (kind: string) => !g.devPlayedThisTurn && g.myDevCards.some((c) => c.kind === kind && c.boughtTurn < g.turn);
  // 내 마을이 닿은 칸에 동상이 있으면 기사를 쓴다
  if (playable('knight') && g.buildings.some((b) => b.owner === me && VERTEX_MAP[b.vertexId].tiles.includes(g.robber))) {
    return { type: 'play_dev', kind: 'knight' };
  }
  if (hasBundle(r, PIECE_COST.city) && count('city') < PIECE_LIMIT.city) {
    const villages = upgradableVillages(g.buildings, me);
    if (villages.length) return { type: 'build_city', vertexId: villages[0] };
  }
  const villageSpots = buildableVillages(g.buildings, g.roads, me);
  if (hasBundle(r, PIECE_COST.village) && count('village') < PIECE_LIMIT.village && villageSpots.length) {
    return { type: 'build_village', vertexId: villageSpots[0] };
  }
  if (playable('road_building') && !villageSpots.length && buildableRoads(g.buildings, g.roads, me).length) return { type: 'play_dev', kind: 'road_building' };
  if (playable('year_of_plenty')) return { type: 'play_dev', kind: 'year_of_plenty', resources: ['stone', 'grain'] };
  if (hasBundle(r, DEV_COST) && g.devDeckCount > 0) return { type: 'buy_dev' };
  if (hasBundle(r, PIECE_COST.road) && count('road') < PIECE_LIMIT.road && !villageSpots.length) {
    const edges = buildableRoads(g.buildings, g.roads, me);
    if (edges.length) return { type: 'build_road', edgeId: edges[(seat * 3 + g.turn) % edges.length] };
  }
  // 다음 목표(도시 → 마을 → 발전 카드)에 모자란 자원 하나를, 목표에 안 쓰는 남는 자원으로 은행에서 바꾼다.
  const target = count('village') > 0 && count('city') < PIECE_LIMIT.city ? PIECE_COST.city : villageSpots.length ? PIECE_COST.village : DEV_COST;
  const missing = RESOURCES.find((x) => r[x] < target[x]);
  if (missing) {
    const give = RESOURCES.find((x) => x !== missing && r[x] - target[x] >= g.myTradeRatios[x]);
    if (give) return { type: 'bank_trade', give, get: missing };
  }
  return { type: 'end_turn' };
}
