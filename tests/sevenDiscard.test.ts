// 방장이 끌 수 있는 7 버리기
import { describe, expect, it } from 'vitest';
import { applyAction, createGame, type GameState } from '../src/shared/rules';
import { RoomManager } from '../src/server/rooms';
import { restoreRooms, snapshotRooms } from '../src/server/persist';

/** 주사위 두 개가 a, b 로 나오게 하는 난수 (그냥 굴리기) */
function diceRandom(a: number, b: number): () => number {
  const seq = [(a - 1) / 6 + 0.01, (b - 1) / 6 + 0.01];
  let i = 0;
  return () => seq[i++ % seq.length];
}

/** 시작 배치를 건너뛰고 첫 사람이 굴릴 차례. 모두 자원 10장을 들고 있다. */
function readyToRoll(sevenDiscard?: boolean): GameState {
  const s = createGame(['a', 'b', 'c'], () => 0.5, { rollForOrder: false, sevenDiscard });
  s.phase = 'playing';
  s.step = 'roll';
  s.current = 0;
  for (const id of s.order) s.players[id].resources = { wood: 3, grain: 3, wool: 2, brick: 1, stone: 1 };
  return s;
}

describe('7 버리기', () => {
  it('기본은 켜져 있어 7이 나오면 한도보다 많이 든 사람이 절반을 버린다', () => {
    const s = readyToRoll();
    expect(s.sevenDiscard).toBe(true);
    const r = applyAction(s, s.order[0], { type: 'roll' }, diceRandom(3, 4));
    expect(r.ok).toBe(true);
    expect(s.step).toBe('discard');
    expect(Object.values(s.discards)).toEqual([5, 5, 5]);
  });

  it('끄면 7이 나와도 아무도 버리지 않고 바로 동상을 옮긴다', () => {
    const s = readyToRoll(false);
    expect(s.sevenDiscard).toBe(false);
    const r = applyAction(s, s.order[0], { type: 'roll' }, diceRandom(3, 4));
    expect(r.ok).toBe(true);
    expect(s.discards).toEqual({});
    expect(s.step).toBe('robber');
    for (const id of s.order) expect(Object.values(s.players[id].resources).reduce((n, x) => n + x, 0)).toBe(10);
  });

  it('방은 기본이 있음이고 방장이 바꿀 수 있으며, 예전 저장 파일은 있음으로 되살린다', () => {
    const m = new RoomManager();
    const made = m.create('방장');
    if ('error' in made) throw new Error(made.error);
    const { room, player } = made;
    expect(room.sevenDiscard).toBe(true);
    expect(m.setSettings(room, player.id, { sevenDiscard: 'no' as never })).not.toBeNull();
    expect(m.setSettings(room, player.id, { sevenDiscard: false })).toBeNull();
    expect(room.sevenDiscard).toBe(false);
    const joined = m.join(room.code, '손님');
    if ('error' in joined) throw new Error(joined.error);
    for (const p of room.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(room, player.id)).toBeNull();
    expect(room.game!.sevenDiscard).toBe(false);
    m.stopAllClocks();
    const data = JSON.parse(snapshotRooms(m.rooms.values()));
    const kept = restoreRooms(JSON.stringify(data)).rooms[0];
    expect(kept.sevenDiscard).toBe(false);
    expect(kept.game!.sevenDiscard).toBe(false);
    delete data.rooms[0].sevenDiscard;
    delete data.rooms[0].game.sevenDiscard;
    const back = restoreRooms(JSON.stringify(data)).rooms[0];
    expect(back.sevenDiscard).toBe(true);
    expect(back.game!.sevenDiscard).toBe(true);
  });
});
