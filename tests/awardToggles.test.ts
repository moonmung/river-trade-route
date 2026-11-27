// 방장이 끌 수 있는 최장 교역로·최강 기사단
import { describe, expect, it } from 'vitest';
import { createGame } from '../src/shared/rules';
import { buildGameView } from '../src/shared/gameView';
import { RoomManager } from '../src/server/rooms';
import { buildRoomView } from '../src/server/view';
import { restoreRooms, snapshotRooms } from '../src/server/persist';

describe('최장 교역로·최강 기사단 켜고 끄기', () => {
  it('게임은 기본이 둘 다 있음이고 하나씩 끌 수 있다', () => {
    const on = createGame(['a', 'b', 'c'], () => 0.5, { rollForOrder: false });
    expect([on.longestRoadAward, on.largestArmyAward]).toEqual([true, true]);
    const off = createGame(['a', 'b', 'c'], () => 0.5, { rollForOrder: false, longestRoadAward: false });
    expect([off.longestRoadAward, off.largestArmyAward]).toEqual([false, true]);
  });

  it('방은 기본이 있음이고 방장만 바꾸며, 시작한 게임과 저장 파일에 그대로 남고 예전 파일은 있음으로 되살린다', () => {
    const m = new RoomManager();
    const made = m.create('방장');
    if ('error' in made) throw new Error(made.error);
    const { room, player } = made;
    expect([room.longestRoadAward, room.largestArmyAward]).toEqual([true, true]);
    const joined = m.join(room.code, '손님');
    if ('error' in joined) throw new Error(joined.error);
    expect(m.setSettings(room, joined.player.id, { longestRoadAward: false })).not.toBeNull();
    expect(m.setSettings(room, player.id, { largestArmyAward: 'no' as never })).not.toBeNull();
    expect(m.setSettings(room, player.id, { longestRoadAward: false, largestArmyAward: false })).toBeNull();
    expect([room.longestRoadAward, room.largestArmyAward]).toEqual([false, false]);
    const lobby = buildRoomView(room, player.id);
    expect([lobby.longestRoadAward, lobby.largestArmyAward]).toEqual([false, false]);
    for (const p of room.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(room, player.id)).toBeNull();
    expect([room.game!.longestRoadAward, room.game!.largestArmyAward]).toEqual([false, false]);
    const view = buildGameView(room.game!, player.id);
    expect([view.longestRoadAward, view.largestArmyAward]).toEqual([false, false]);
    m.stopAllClocks();
    const data = JSON.parse(snapshotRooms(m.rooms.values()));
    const kept = restoreRooms(JSON.stringify(data)).rooms[0];
    expect([kept.longestRoadAward, kept.largestArmyAward, kept.game!.longestRoadAward, kept.game!.largestArmyAward]).toEqual([false, false, false, false]);
    for (const k of ['longestRoadAward', 'largestArmyAward']) {
      delete data.rooms[0][k];
      delete data.rooms[0].game[k];
    }
    const back = restoreRooms(JSON.stringify(data)).rooms[0];
    expect([back.longestRoadAward, back.largestArmyAward, back.game!.longestRoadAward, back.game!.largestArmyAward]).toEqual([true, true, true, true]);
  });
});
