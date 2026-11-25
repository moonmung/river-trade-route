// 플레이어 색 12가지와 대기실에서 색 바꾸기
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_PLAYERS, PLAYER_COLOR_COUNT } from '../src/shared/constants';
import type { SessionInfo } from '../src/shared/protocol';
import { RoomManager } from '../src/server/rooms';
import { startServer, type RunningServer } from '../src/server/app';
import { PLAYER_COLORS } from '../src/client/theme';
import { colorWord } from '../src/client/game/derive';
import { TestClient } from './helpers';

function room(guests = 1) {
  const m = new RoomManager();
  const made = m.create('방장');
  if ('error' in made) throw new Error(made.error);
  const players = [made.player];
  for (let i = 0; i < guests; i++) {
    const j = m.join(made.room.code, `손님${i + 1}`);
    if ('error' in j) throw new Error(j.error);
    players.push(j.player);
  }
  return { m, room: made.room, players };
}

describe('색 목록', () => {
  it('12가지이고 색 값과 부르는 말이 모두 다르다', () => {
    expect(PLAYER_COLORS).toHaveLength(PLAYER_COLOR_COUNT);
    expect(PLAYER_COLOR_COUNT).toBeGreaterThanOrEqual(MAX_PLAYERS);
    expect(new Set(PLAYER_COLORS.map((c) => c.hex)).size).toBe(12);
    const words = Array.from({ length: 12 }, (_, i) => colorWord(i));
    expect(new Set(words).size).toBe(12);
    // 예전에는 부르는 말이 4개뿐이라 다섯 번째 사람(4번 색)이 "빨강"으로 불렸다.
    expect(colorWord(4)).toBe('초록');
    expect(colorWord(0)).toBe('빨강');
  });
});

describe('대기실에서 색 바꾸기', () => {
  it('들어온 순서대로 비어 있는 앞 색을 받는다', () => {
    const { players } = room(2);
    expect(players.map((p) => p.colorIndex)).toEqual([0, 1, 2]);
  });

  it('남이 쓰지 않는 색으로 바꾸고, 준비 상태는 그대로다', () => {
    const { m, room: r, players } = room(1);
    const [host, guest] = players;
    expect(m.setReady(r, guest.id, true)).toBeNull();
    expect(m.setColor(r, guest.id, 11)).toBeNull();
    expect(guest.colorIndex).toBe(11);
    expect(guest.ready).toBe(true);
    // 같은 색을 다시 골라도 괜찮다
    expect(m.setColor(r, guest.id, 11)).toBeNull();
    // 비게 된 1번 색은 다른 사람이 쓸 수 있다
    expect(m.setColor(r, host.id, 1)).toBeNull();
    expect(host.colorIndex).toBe(1);
  });

  it('남이 쓰는 색, 없는 색, 이상한 값은 거절한다', () => {
    const { m, room: r, players } = room(1);
    const [host, guest] = players;
    expect(m.setColor(r, guest.id, host.colorIndex)?.error).toContain('방장 님이 쓰는 색');
    for (const bad of [-1, 12, 1.5, '3', null, undefined, NaN]) expect(m.setColor(r, guest.id, bad)).not.toBeNull();
    expect(guest.colorIndex).toBe(1);
    expect(m.setColor(r, 'p_없음', 5)).not.toBeNull();
  });

  it('게임 중에는 바꿀 수 없다', () => {
    const { m, room: r, players } = room(1);
    for (const p of r.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(r, players[0].id)).toBeNull();
    expect(m.setColor(r, players[1].id, 7)?.error).toContain('대기실에서만');
    m.stopAllClocks();
  });
});

describe('서버 연결로 색 바꾸기', () => {
  let server: RunningServer;
  let url: string;

  beforeAll(async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', clientDir: null });
    url = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('room:color 로 바꾸면 같은 방 모두에게 새 색이 간다', async () => {
    const host = new TestClient(url);
    await host.connected();
    const created = await host.emit<SessionInfo>('room:create', { nickname: '방장' });
    if (!created.ok) throw new Error(created.error);
    host.session = created;
    const guest = new TestClient(url);
    await guest.connected();
    const joined = await guest.emit<SessionInfo>('room:join', { code: created.roomCode, nickname: '손님' });
    if (!joined.ok) throw new Error(joined.error);
    guest.session = joined;

    expect(await guest.emit('room:color', { colorIndex: 9 })).toEqual({ ok: true });
    const v = await host.waitFor((x) => x.players.some((p) => p.id === guest.id && p.colorIndex === 9));
    expect(v.players.find((p) => p.id === host.id)?.colorIndex).toBe(0);
    expect(await host.emit('room:color', { colorIndex: 9 })).toMatchObject({ ok: false });
    expect(await host.emit('room:color', {})).toMatchObject({ ok: false });
    host.close();
    guest.close();
  });
});
