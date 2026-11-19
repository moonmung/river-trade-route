import { describe, expect, it } from 'vitest';
import { RoomManager, isRoomError, type Room } from '../src/server/rooms';

function mustCreate(m: RoomManager, nick: string): Room {
  const res = m.create(nick);
  if (isRoomError(res)) throw new Error(res.error);
  return res.room;
}

describe('방 개수 한도', () => {
  it('가득 차면 아무도 접속하지 않은 대기실부터 정리해 새 방을 만든다', () => {
    const m = new RoomManager(3);
    const rooms = [mustCreate(m, 'a'), mustCreate(m, 'b'), mustCreate(m, 'c')];
    // 한 사람만 접속해 있는 방은 남는다.
    rooms[0].players[0].connected = true;
    const fresh = m.create('d');
    expect(isRoomError(fresh)).toBe(false);
    expect(m.rooms.has(rooms[0].code)).toBe(true);
    expect(m.rooms.has(rooms[1].code)).toBe(false);
    expect(m.rooms.has(rooms[2].code)).toBe(false);
  });

  it('모두 잠깐 끊긴 진행 중인 게임은 남기고, 30분 넘게 비어 있던 게임만 정리한다', () => {
    const m = new RoomManager(2);
    const recent = mustCreate(m, 'a');
    const stale = mustCreate(m, 'b');
    for (const r of [recent, stale]) {
      r.phase = 'game';
      r.players[0].connected = false;
    }
    recent.touchedAt = Date.now() - 60_000;
    stale.touchedAt = Date.now() - 31 * 60_000;
    expect(isRoomError(m.create('c'))).toBe(false);
    expect(m.rooms.has(recent.code)).toBe(true);
    expect(m.rooms.has(stale.code)).toBe(false);
    // 더 정리할 방이 없으면 거절한다.
    const other = [...m.rooms.values()].find((r) => r !== recent)!;
    other.players[0].connected = true;
    expect(isRoomError(m.create('d'))).toBe(true);
  });

  it('혼자 있는 대기실만 closeIfLoneLobby 로 닫힌다', () => {
    const m = new RoomManager();
    const lone = mustCreate(m, 'a');
    const shared = mustCreate(m, 'b');
    const joined = m.join(shared.code, 'c');
    expect(isRoomError(joined)).toBe(false);
    expect(m.closeIfLoneLobby(shared, shared.players[0].id)).toBe(false);
    expect(m.closeIfLoneLobby(lone, 'someone-else')).toBe(false);
    expect(m.closeIfLoneLobby(lone, lone.players[0].id)).toBe(true);
    expect(m.rooms.has(lone.code)).toBe(false);
  });
});
