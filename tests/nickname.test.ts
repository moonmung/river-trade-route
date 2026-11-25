// 대기실에서 내 이름 바꾸기
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/shared/protocol';
import { RoomManager, isRoomError } from '../src/server/rooms';
import { startServer, type RunningServer } from '../src/server/app';
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

describe('대기실에서 이름 바꾸기', () => {
  it('정리한 새 이름으로 바꾸고, 준비 상태와 색은 그대로다', () => {
    const { m, room: r, players } = room(1);
    const guest = players[1];
    expect(m.setReady(r, guest.id, true)).toBeNull();
    const color = guest.colorIndex;
    expect(m.setNickname(r, guest.id, '  강   나루 ')).toEqual({ nickname: '강 나루' });
    expect(guest.nickname).toBe('강 나루');
    expect(guest.ready).toBe(true);
    expect(guest.colorIndex).toBe(color);
    // 같은 이름을 다시 보내도 괜찮다
    expect(m.setNickname(r, guest.id, '강 나루')).toEqual({ nickname: '강 나루' });
  });

  it('바꾸고 나면 예전 이름은 다른 사람이 쓸 수 있다', () => {
    const { m, room: r, players } = room(1);
    const [host, guest] = players;
    expect(isRoomError(m.setNickname(r, guest.id, '나루'))).toBe(false);
    expect(m.setNickname(r, host.id, '손님1')).toEqual({ nickname: '손님1' });
    const j = m.join(r.code, '방장');
    expect(isRoomError(j)).toBe(false);
  });

  it('남이 쓰는 이름(대소문자만 다른 것 포함), 빈 이름, 너무 긴 이름, 이상한 값은 거절한다', () => {
    const { m, room: r, players } = room(1);
    const [host, guest] = players;
    expect(m.setNickname(r, host.id, 'Alice')).toEqual({ nickname: 'Alice' });
    const taken = m.setNickname(r, guest.id, 'alice');
    expect(isRoomError(taken) && taken.code).toBe('NICK_TAKEN');
    expect(isRoomError(m.setNickname(r, guest.id, '방장'))).toBe(false);
    for (const bad of ['', '   ', '가'.repeat(13), 12, null, undefined, {}]) {
      expect(isRoomError(m.setNickname(r, host.id, bad))).toBe(true);
    }
    expect(host.nickname).toBe('Alice');
    expect(isRoomError(m.setNickname(r, 'p_없음', '누구'))).toBe(true);
  });

  it('게임 중에는 바꿀 수 없다', () => {
    const { m, room: r, players } = room(1);
    for (const p of r.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(r, players[0].id)).toBeNull();
    const res = m.setNickname(r, players[1].id, '새이름');
    expect(isRoomError(res) && res.error).toContain('대기실에서만');
    expect(players[1].nickname).toBe('손님1');
    m.stopAllClocks();
  });
});

describe('서버 연결로 이름 바꾸기', () => {
  let server: RunningServer;
  let url: string;

  beforeAll(async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', clientDir: null });
    url = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('room:nickname 으로 바꾸면 같은 방 모두에게 새 이름이 간다', async () => {
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

    expect(await guest.emit('room:nickname', { nickname: ' 나루 ' })).toEqual({ ok: true, nickname: '나루' });
    await host.waitFor((x) => x.players.some((p) => p.id === guest.id && p.nickname === '나루'));
    expect(await host.emit('room:nickname', { nickname: '나루' })).toMatchObject({ ok: false, code: 'NICK_TAKEN' });
    expect(await host.emit('room:nickname', {})).toMatchObject({ ok: false });
    host.close();
    guest.close();
  });
});
