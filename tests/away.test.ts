// 자리 비움(자동): 켜 둔 사람 대신 서버가 잠시 뒤 한 수씩 둔다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_AFTER_ROLL_MS, RoomManager, type Room, type RoomPlayer } from '../src/server/rooms';
import { restoreRooms, snapshotRooms } from '../src/server/persist';
import { currentPlayer } from '../src/shared/rules';
import { emptyBundle } from '../src/shared/constants';

function threePlayers(): { m: RoomManager; room: Room; host: RoomPlayer; players: RoomPlayer[] } {
  const m = new RoomManager();
  const made = m.create('방장');
  if ('error' in made) throw new Error(made.error);
  for (const name of ['손님1', '손님2']) {
    const j = m.join(made.room.code, name);
    if ('error' in j) throw new Error(j.error);
  }
  const { room, player: host } = made;
  // 차례 시간이 대신 진행하지 않게 제한을 없앤다 (자동만 보려고)
  expect(m.setSettings(room, host.id, { turnSeconds: 0 })).toBeNull();
  for (const p of room.players) {
    p.connected = true;
    p.ready = true;
  }
  expect(m.start(room, host.id)).toBeNull();
  return { m, room, host, players: room.players };
}

/** 자동이 한 수씩 둘 시간을 준다 (stepMs 마다 until 을 본다) */
function run(m: RoomManager, steps: number, until: () => boolean = () => false, stepMs = AUTO_AFTER_ROLL_MS): void {
  for (let i = 0; i < steps && !until(); i++) vi.advanceTimersByTime(stepMs);
}

describe('자리 비움 (자동)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('대기실에서는 켤 수 없고, 게임 중에는 켜고 끌 수 있다', () => {
    const m = new RoomManager();
    const made = m.create('방장');
    if ('error' in made) throw new Error(made.error);
    expect(m.setAuto(made.room, made.player.id, true)).not.toBeNull();
    expect(made.player.auto).toBe(false);
  });

  it('모두 자리를 비우면 순서 정하기부터 시작 배치를 지나 여러 턴을 서버가 대신 둔다', () => {
    const { m, room } = threePlayers();
    for (const p of room.players) expect(m.setAuto(room, p.id, true)).toBeNull();
    run(m, 600, () => room.game!.phase === 'playing' && room.game!.turn >= 5);
    const g = room.game!;
    expect(g.phase).toBe('playing');
    expect(g.turn).toBeGreaterThanOrEqual(5);
    expect(g.buildings.length).toBeGreaterThanOrEqual(6);
    m.stopAllClocks();
  });

  it('자리 비운 사람만 대신 두고, 직접 두면 자동이 꺼진다', () => {
    const { m, room, players } = threePlayers();
    for (const p of players) expect(m.setAuto(room, p.id, true)).toBeNull();
    // 잘게 나눠 기다려서, 첫 턴 주사위를 굴리기 전에 멈춘다
    run(m, 4000, () => room.game!.phase === 'playing', 200);
    const g = room.game!;
    expect(g.step).toBe('roll');
    // 지금 차례인 사람의 자동을 끄면 그 차례에서 멈춘다
    const cur = currentPlayer(g)!;
    expect(m.setAuto(room, cur, false)).toBeNull();
    const turn = g.turn;
    run(m, 20);
    expect(g.turn).toBe(turn);
    expect(g.step).toBe('roll');
    // 다시 켰다가 직접 두면 꺼진다
    expect(m.setAuto(room, cur, true)).toBeNull();
    const me = room.players.find((p) => p.id === cur)!;
    const { result } = m.act(room, cur, 'manual-1', { type: 'roll' });
    expect(result.ok).toBe(true);
    expect(me.auto).toBe(false);
    m.stopAllClocks();
  });

  it('자리 비운 사람에게 온 교환 제안은 거절한다', () => {
    const { m, room, players } = threePlayers();
    for (const p of players) expect(m.setAuto(room, p.id, true)).toBeNull();
    run(m, 600, () => room.game!.phase === 'playing' && room.game!.step === 'main');
    const g = room.game!;
    const cur = currentPlayer(g)!;
    // 차례인 사람이 돌아와 다른 둘에게 교환을 제안한다
    expect(m.setAuto(room, cur, false)).toBeNull();
    g.players[cur].resources = { ...emptyBundle(), wood: 2 };
    for (const p of players) if (p.id !== cur) g.players[p.id].resources = { ...emptyBundle(), stone: 3 };
    const res = m.act(room, cur, 'offer-1', { type: 'trade_propose', give: { ...emptyBundle(), wood: 1 }, get: { ...emptyBundle(), stone: 1 } });
    expect(res.result.ok).toBe(true);
    run(m, 4);
    // 모두 거절하면 제안이 닫힌다 (기록에 거절 두 번과 닫힘이 남는다)
    const answers = g.events.filter((e) => e.kind === 'trade_response');
    for (const p of players) {
      if (p.id === cur) continue;
      expect(answers.some((e) => e.kind === 'trade_response' && e.player === p.id && e.response === 'rejected')).toBe(true);
    }
    expect(answers.some((e) => e.kind === 'trade_response' && e.response !== 'rejected')).toBe(false);
    expect(g.trades.length).toBe(0);
    m.stopAllClocks();
  });

  it('저장했다 되살려도 자리 비움이 남고, 예전 파일은 꺼진 채로 되살린다', () => {
    const { m, room, players } = threePlayers();
    expect(m.setAuto(room, players[1].id, true)).toBeNull();
    m.stopAllClocks();
    const data = JSON.parse(snapshotRooms(m.rooms.values()));
    const back = restoreRooms(JSON.stringify(data)).rooms[0];
    expect(back.players[1].auto).toBe(true);
    expect(back.players[0].auto).toBe(false);
    for (const p of data.rooms[0].players) delete p.auto;
    const old = restoreRooms(JSON.stringify(data)).rooms[0];
    expect(old.players.every((p) => p.auto === false)).toBe(true);
  });

  it('게임이 끝나 대기실로 돌아가면 자리 비움이 풀린다', () => {
    const { m, room, host, players } = threePlayers();
    expect(m.setAuto(room, players[1].id, true)).toBeNull();
    room.game!.phase = 'finished';
    expect(m.rematch(room, host.id)).toBeNull();
    expect(players[1].auto).toBe(false);
    m.stopAllClocks();
  });
});
