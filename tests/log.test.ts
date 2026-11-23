// 전체 기록 창의 턴 묶기
import { describe, expect, it } from 'vitest';
import { groupByTurn } from '../src/client/game/logTurns';
import type { GameEvent } from '../src/shared/types';

describe('전체 기록', () => {
  it('기록을 턴별로 묶고 최근 턴을 위로, 턴을 둔 사람은 그 턴의 굴림에서 찾는다', () => {
    const events: GameEvent[] = [
      { seq: 1, turn: 0, kind: 'game_start', order: ['a', 'b'] },
      { seq: 2, turn: 0, kind: 'placement', player: 'a', vertexId: 'v1', edgeId: 'e1' },
      { seq: 3, turn: 1, kind: 'roll', player: 'a', dice: [3, 4], gains: {}, tiles: [], blocked: [] },
      { seq: 4, turn: 1, kind: 'robber', player: 'a', tileId: 'B2' },
      { seq: 5, turn: 1, kind: 'steal', player: 'a', from: 'b' },
      { seq: 6, turn: 1, kind: 'turn_end', player: 'a' },
      // 굴리기 전에 기사를 써도 그 사람이 턴 주인이다
      { seq: 7, turn: 2, kind: 'play_dev', player: 'b', card: 'knight' },
      { seq: 8, turn: 2, kind: 'roll', player: 'b', dice: [1, 1], gains: {}, tiles: [], blocked: [] },
    ];
    const groups = groupByTurn(events);
    expect(groups.map((g) => [g.turn, g.player, g.events.map((e) => e.seq)])).toEqual([
      [2, 'b', [7, 8]],
      [1, 'a', [3, 4, 5, 6]],
      [0, null, [1, 2]],
    ]);
  });
});
