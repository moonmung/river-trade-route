// 통합 테스트용 도우미: 실제 서버를 띄우고 Socket.IO 클라이언트 여러 개로 참가한다.
import { io as connect, type Socket } from 'socket.io-client';
import { expect } from 'vitest';
import { BUILD_COST, CONTRACTS, RESOURCES, TILES, hasBundle } from '../src/shared/constants';
import type { AckResult, RoomView, SessionInfo } from '../src/shared/protocol';
import { buildableTiles, placeableTiles, settlementsOf } from '../src/shared/rules';
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

/** 간단한 봇: 납품 → 건설 → 시장 → 턴 종료 순으로 고른다. */
export function chooseAction(v: RoomView, seat: number): GameAction {
  const g = v.game!;
  const me = v.you;
  const r = g.myResources;
  if (g.phase === 'placement') {
    const free = placeableTiles(g.settlements);
    // 자리마다 다른 쪽에서 시작해 거점이 고르게 퍼지게 한다.
    const preferred = [...TILES].map((t) => t.id).filter((id) => free.includes(id));
    return { type: 'place', tileId: preferred[(seat * 5) % preferred.length] };
  }
  if (g.actionsLeft <= 0) return { type: 'end_turn' };
  for (const c of CONTRACTS) {
    const open = !g.contracts.find((x) => x.id === c.id)?.completedBy;
    if (open && hasBundle(r, c.cost)) return { type: 'deliver', contractId: c.id };
  }
  if (settlementsOf(g.settlements, me).length < 3 && hasBundle(r, BUILD_COST)) {
    const tiles = buildableTiles(g.settlements, me);
    if (tiles.length) return { type: 'build', tileId: tiles[0] };
  }
  const most = RESOURCES.reduce((a, b) => (r[a] >= r[b] ? a : b));
  if (r[most] >= 3) {
    const least = RESOURCES.filter((x) => x !== most).reduce((a, b) => (r[a] <= r[b] ? a : b));
    return { type: 'market', give: most, get: least };
  }
  return { type: 'end_turn' };
}
