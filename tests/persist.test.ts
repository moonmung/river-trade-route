// 서버를 다시 켜도 이어 하기: 저장 파일, 되살리기, 같은 토큰으로 재접속, 자리 넘기기.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoomView, SeatHandover, SessionInfo } from '../src/shared/protocol';
import { startServer, type RunningServer } from '../src/server/app';
import { DAY_MS, RoomStore, restoreRooms, snapshotRooms, writeFileAtomic } from '../src/server/persist';
import { RoomManager, isRoomError, type Room } from '../src/server/rooms';
import { TestClient, byId, chooseAction, startedRoom, sync } from './helpers';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rr-persist-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let fileSeq = 0;
function freshFile(): string {
  return path.join(dir, `case-${++fileSeq}`, 'rooms.json');
}

async function serve(dataFile: string, persist = { debounceMs: 30, maxWaitMs: 120 }): Promise<{ server: RunningServer; url: string }> {
  const server = await startServer({ port: 0, host: '127.0.0.1', clientDir: null, dataFile, persist });
  return { server, url: `http://127.0.0.1:${server.port}` };
}

/** 차례인 사람이 봇 규칙으로 n 수를 둔다 (시작 배치 포함). */
async function playSteps(clients: TestClient[], n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const g = clients[0].latest!.game!;
    if (g.phase === 'finished') return;
    const who = g.phase === 'placement' ? g.placementPlayerId : g.step === 'discard' ? (Object.keys(g.discards)[0] ?? g.currentPlayerId) : g.currentPlayerId;
    const actor = byId(clients, who);
    const res = await actor.act(chooseAction(actor.latest!, g.order.indexOf(actor.id)));
    expect(res).toEqual({ ok: true });
    await sync(clients, actor.latest!.game!.version);
  }
}

/** 저장 파일에 적힌 그 방의 게임 버전 */
function savedVersion(file: string, code: string): number | null {
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, 'utf8')) as { rooms: { code: string; game: { version: number } | null }[] };
  return data.rooms.find((r) => r.code === code)?.game?.version ?? null;
}

async function waitUntil(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('조건을 기다리다 시간 초과');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function reconnect(url: string, s: SessionInfo): TestClient {
  const c = new TestClient(url, { roomCode: s.roomCode, token: s.token });
  c.session = s;
  return c;
}

describe('서버 재시작 뒤 이어 하기', () => {
  it('저장 → 서버가 갑자기 꺼짐 → 다시 켬 → 같은 토큰으로 재접속하면 같은 자리·같은 손패로 이어서 진행한다', async () => {
    const file = freshFile();
    const a = await serve(file);
    const { clients, code } = await startedRoom(a.url, 3);
    await playSteps(clients, 12); // 시작 배치 6수 + 몇 턴
    const before = new Map(clients.map((c) => [c.id, structuredClone(c.latest!.game!)]));
    const version = clients[0].latest!.game!.version;
    const sessions = clients.map((c) => c.session!);

    // 디바운스 저장이 끝나기를 기다렸다가 파일을 복사한다 = 그 순간 프로세스가 죽은 것과 같다 (종료 처리 없이).
    await waitUntil(() => savedVersion(file, code) === version);
    const crashed = freshFile();
    writeFileAtomic(crashed, readFileSync(file, 'utf8'));
    clients.forEach((c) => c.close());
    await a.server.close();

    const b = await serve(crashed);
    expect(b.server.restored).toBe(1);
    // 되살린 직후에는 모두 연결 끊김
    const room = b.server.rooms.rooms.get(code)!;
    expect(room.players.every((p) => !p.connected && p.socketId === null)).toBe(true);

    // 차례인 사람보다 먼저 다른 사람이 돌아오면 차례인 사람을 기다린다고 보인다.
    const turnId = before.get(sessions[0].playerId)!.currentPlayerId ?? before.get(sessions[0].playerId)!.placementPlayerId;
    const waiterSession = sessions.find((s) => s.playerId !== turnId)!;
    const waiter = reconnect(b.url, waiterSession);
    const seen = await waiter.waitFor((v) => v.phase === 'game');
    expect(seen.players.find((p) => p.id === turnId)!.connected).toBe(false);
    expect(seen.game!.currentPlayerId ?? seen.game!.placementPlayerId).toBe(turnId);
    expect(await waiter.act({ type: 'end_turn' })).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });

    const back = [waiter, ...sessions.filter((s) => s !== waiterSession).map((s) => reconnect(b.url, s))];
    for (const c of back) {
      const v = await c.waitFor((x) => x.phase === 'game' && x.players.every((p) => p.connected));
      const old = before.get(c.id)!;
      expect(v.you).toBe(c.id);
      expect(v.game!.version).toBe(version);
      expect(v.game!.myResources).toEqual(old.myResources);
      expect(v.game!.myDevCards).toEqual(old.myDevCards);
      expect(v.game!.buildings).toEqual(old.buildings);
      expect(v.game!.roads).toEqual(old.roads);
      expect(v.game!.currentPlayerId).toBe(old.currentPlayerId);
      expect(v.game!.step).toBe(old.step);
    }

    // 이어서 진행
    await playSteps(back, 6);
    expect(back[0].latest!.game!.version).toBeGreaterThan(version);
    back.forEach((c) => c.close());
    await b.server.close();
  });

  it('정상 종료(Ctrl+C·창 닫기)는 기다리던 저장까지 쓰고, 같은 요청 ID 는 재시작 뒤에도 한 번만 반영된다', async () => {
    const file = freshFile();
    // 디바운스를 길게 잡아 종료 때 flush 가 쓴 것만 남게 한다.
    const a = await serve(file, { debounceMs: 60_000, maxWaitMs: 60_000 });
    const { clients, code } = await startedRoom(a.url, 3);
    await playSteps(clients, 6);
    const g = clients[0].latest!.game!;
    expect(g.phase).toBe('playing');
    const actor = byId(clients, g.currentPlayerId);
    expect(await actor.act({ type: 'roll' }, 'same-request-1')).toEqual({ ok: true });
    await sync(clients, actor.latest!.game!.version);
    const version = actor.latest!.game!.version;
    const session = actor.session!;
    expect(savedVersion(file, code)).toBeNull(); // 아직 디바운스 대기 중
    clients.forEach((c) => c.close());
    await a.server.close();
    expect(savedVersion(file, code)).toBe(version);
    expect(readdirSync(path.dirname(file))).toEqual(['rooms.json']); // 임시 파일이 남지 않는다

    const b = await serve(file);
    const again = reconnect(b.url, session);
    await again.waitFor((v) => v.phase === 'game');
    // 응답을 못 받은 브라우저가 같은 ID 로 다시 보낸 경우: 처음 결과를 돌려주고 다시 굴리지 않는다.
    expect(await again.act({ type: 'roll' }, 'same-request-1')).toEqual({ ok: true });
    expect(b.server.rooms.rooms.get(code)!.game!.version).toBe(version);
    again.close();
    await b.server.close();
  });
});

describe('저장 파일', () => {
  function gameRoom(m: RoomManager): Room {
    const created = m.create('가');
    if (isRoomError(created)) throw new Error(created.error);
    const room = created.room;
    for (const n of ['나', '다']) if (isRoomError(m.join(room.code, n))) throw new Error('join');
    for (const p of room.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(room, room.hostId)).toBeNull();
    return room;
  }

  it('게임 상태를 통째로 저장하고, 되살린 자리는 연결 끊김으로 시작한다', () => {
    const m = new RoomManager();
    const room = gameRoom(m);
    const g = room.game!;
    const first = g.order[0];
    m.act(room, first, 'r1', { type: 'end_turn' }); // 거절되는 요청도 기록된다
    const text = snapshotRooms(m.rooms.values());
    const { rooms } = restoreRooms(text);
    expect(rooms).toHaveLength(1);
    const back = rooms[0];
    expect(back.game).toEqual(room.game);
    expect(back.players.map((p) => [p.id, p.token, p.nickname, p.colorIndex])).toEqual(room.players.map((p) => [p.id, p.token, p.nickname, p.colorIndex]));
    expect(back.players.every((p) => !p.connected && p.socketId === null)).toBe(true);
    expect(back.players.find((p) => p.id === first)!.recent.get('r1')).toEqual(room.players.find((p) => p.id === first)!.recent.get('r1'));
    // 접속 정보는 파일에 들어가지 않는다
    expect(text).not.toMatch(/socketId|"connected"/);
  });

  it('끝난 게임과 하루 넘게 쓰지 않은 방은 저장하지도 되살리지도 않는다', () => {
    const m = new RoomManager();
    const finished = gameRoom(m);
    finished.game!.phase = 'finished';
    const old = gameRoom(m);
    old.touchedAt = Date.now() - DAY_MS - 1000;
    const fresh = gameRoom(m);
    const text = snapshotRooms(m.rooms.values());
    expect(restoreRooms(text).rooms.map((r) => r.code)).toEqual([fresh.code]);
    // 저장할 때는 살아 있던 방도 되살릴 때 하루가 지났으면 버린다.
    expect(restoreRooms(text, Date.now() + DAY_MS + 1000).rooms).toHaveLength(0);
  });

  it('규칙이 바뀌어 모양이 맞지 않는 게임이나 망가진 방은 그 방만 건너뛴다', () => {
    const m = new RoomManager();
    const good = gameRoom(m);
    const bad = gameRoom(m);
    const data = JSON.parse(snapshotRooms(m.rooms.values())) as { rooms: { code: string; game: Record<string, unknown> }[] };
    delete data.rooms.find((r) => r.code === bad.code)!.game.devDeck;
    data.rooms.push({ code: 'not a room' } as never);
    const res = restoreRooms(JSON.stringify(data));
    expect(res.rooms.map((r) => r.code)).toEqual([good.code]);
    expect(res.skipped).toBe(2);
    expect(() => restoreRooms('{"rooms": [')).toThrow();
  });

  it('깨진 파일은 옆으로 옮겨 두고 빈 상태로 시작하며, 쓰다 만 임시 파일은 무시한다', () => {
    const file = freshFile();
    writeFileAtomic(file, '{ "format": 1, "rooms": [ {"code":');
    const logs: string[] = [];
    const m = new RoomManager();
    expect(new RoomStore(m, file, { log: (s) => logs.push(s) }).load()).toBe(0);
    expect(logs.join('\n')).toMatch(/깨져/);
    expect(readdirSync(path.dirname(file)).some((f) => f.startsWith('rooms.json.broken-'))).toBe(true);

    // 정상 파일 + 쓰다 만 임시 파일(바꿔치기 전에 꺼진 경우) → 정상 파일을 쓴다
    const src = new RoomManager();
    const room = gameRoom(src);
    const file2 = freshFile();
    writeFileAtomic(file2, snapshotRooms(src.rooms.values()));
    writeFileSync(`${file2}.tmp`, '{"format":1,"rooms":[{"co');
    const m2 = new RoomManager();
    expect(new RoomStore(m2, file2).load()).toBe(1);
    expect(m2.rooms.get(room.code)!.game).toEqual(room.game);
  });

  it('변화가 몰려도 짧게 모아 한 번 쓰고, 계속 바뀌어도 maxWait 안에는 쓴다', async () => {
    const file = freshFile();
    const m = new RoomManager();
    const store = new RoomStore(m, file, { debounceMs: 40, maxWaitMs: 150 });
    store.attach();
    gameRoom(m); // 생성·참가·준비·시작으로 onChange 가 여러 번 불린다
    expect(existsSync(file)).toBe(false);
    await waitUntil(() => existsSync(file));
    const firstWrite = store.lastWrite!.at;
    // 30ms 마다 계속 바뀌어도 150ms 안에 한 번은 쓴다.
    const started = Date.now();
    const timer = setInterval(() => m.onChange?.(), 30);
    await waitUntil(() => store.lastWrite!.at > firstWrite, 1000);
    clearInterval(timer);
    expect(store.lastWrite!.at - started).toBeLessThan(400);
    store.close();
  });
});

describe('자리 넘기기 (다른 브라우저·기기로 옮길 때)', () => {
  let server: RunningServer;
  let url: string;
  let file: string;
  beforeAll(async () => {
    file = freshFile();
    ({ server, url } = await serve(file));
  });
  afterAll(async () => {
    await server.close();
  });

  it('방장이 끊긴 자리의 코드를 만들고, 새 기기가 그 코드로 같은 자리·같은 손패를 받는다. 예전 토큰은 더 이상 안 된다', async () => {
    const { clients, code } = await startedRoom(url, 3);
    await playSteps(clients, 6);
    const host = clients[0];
    const [, guest, other] = clients;
    const hand = { ...guest.latest!.game!.myResources };
    const oldSession = guest.session!;

    // 접속해 있는 자리는 넘길 수 없다. 방장이 아니면 만들 수 없다.
    expect(await host.emit('seat:handover', { playerId: guest.id })).toMatchObject({ ok: false });
    guest.close();
    await host.waitFor((v) => v.players.find((p) => p.id === guest.id)!.connected === false);
    expect(await other.emit('seat:handover', { playerId: guest.id })).toMatchObject({ ok: false });

    const issued = await host.emit<SeatHandover>('seat:handover', { playerId: guest.id });
    if (!issued.ok) throw new Error(issued.error);
    expect(issued.code).toMatch(/^\d{6}$/);
    // 방장에게만 응답하고 다른 사람에게 코드가 퍼지지 않는다.
    expect(JSON.stringify(other.received)).not.toContain(issued.code);

    const fresh = new TestClient(url);
    await fresh.connected();
    expect(await fresh.emit('seat:claim', { code, seatCode: '000000' === issued.code ? '111111' : '000000' })).toMatchObject({ ok: false, code: 'SEAT_CODE' });
    expect(await fresh.emit('seat:claim', { code, seatCode: 'abc' })).toMatchObject({ ok: false });
    const claimed = await fresh.emit<SessionInfo>('seat:claim', { code, seatCode: issued.code });
    if (!claimed.ok) throw new Error(claimed.error);
    expect(claimed.playerId).toBe(oldSession.playerId);
    expect(claimed.token).not.toBe(oldSession.token);
    fresh.session = claimed;
    const v = await fresh.waitFor((x: RoomView) => x.phase === 'game' && x.you === oldSession.playerId);
    expect(v.game!.myResources).toEqual(hand);
    await host.waitFor((x) => x.players.find((p) => p.id === guest.id)!.connected === true);

    // 같은 코드는 한 번만 쓴다.
    const third = new TestClient(url);
    await third.connected();
    expect(await third.emit('seat:claim', { code, seatCode: issued.code })).toMatchObject({ ok: false, code: 'SEAT_CODE' });

    // 예전 기기에 남은 토큰으로는 붙지 못하고, 넘어갔다는 이유를 받는다.
    const stale = reconnect(url, oldSession);
    const [info] = (await stale.waitEvent('session:invalid')) as [{ reason: string }];
    expect(info.reason).toMatch(/다른 기기로 넘어갔습니다/);

    // 넘겨받은 토큰은 저장 파일에 들어가 서버를 다시 켜도 유지되고, 예전 토큰은 파일에서도 사라진다.
    await waitUntil(() => existsSync(file) && readFileSync(file, 'utf8').includes(claimed.token));
    expect(readFileSync(file, 'utf8')).not.toContain(oldSession.token);
    [...clients, fresh, third, stale].forEach((c) => c.close());
  });

  it('방장이 끊겨 있으면 접속해 있는 다른 사람이 코드를 만들 수 있다', async () => {
    const { clients } = await startedRoom(url, 3);
    const [host, a, b] = clients;
    host.close();
    await a.waitFor((v) => v.players.find((p) => p.id === host.id)!.connected === false);
    const issued = await a.emit<SeatHandover>('seat:handover', { playerId: host.id });
    expect(issued).toMatchObject({ ok: true, playerId: host.id });
    // 끊긴 사람이 없으면 넘길 자리도 없다.
    expect(await a.emit('seat:handover', { playerId: b.id })).toMatchObject({ ok: false });
    [a, b].forEach((c) => c.close());
  });

  it('코드를 여러 번 틀리면 그 방의 코드가 모두 지워진다', async () => {
    const { clients, code } = await startedRoom(url, 3);
    const [host, guest] = clients;
    guest.close();
    await host.waitFor((v) => v.players.find((p) => p.id === guest.id)!.connected === false);
    const issued = await host.emit<SeatHandover>('seat:handover', { playerId: guest.id });
    if (!issued.ok) throw new Error(issued.error);
    const guesser = new TestClient(url);
    await guesser.connected();
    let wrong = 0;
    for (let i = 0; wrong < 8; i++) {
      const guess = String(i).padStart(6, '0');
      if (guess === issued.code) continue;
      await guesser.emit('seat:claim', { code, seatCode: guess });
      wrong++;
    }
    expect(await guesser.emit('seat:claim', { code, seatCode: issued.code })).toMatchObject({ ok: false, code: 'SEAT_CODE' });
    [...clients, guesser].forEach((c) => c.close());
  });
});
