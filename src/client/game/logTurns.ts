// 전체 기록 창(log.tsx 의 LogOverlay)이 쓰는 턴 묶기. 화면 없이 테스트할 수 있게 따로 둔다.
import type { GameEvent } from '../../shared/types';

export interface TurnGroup {
  turn: number;
  /** 그 턴을 둔 사람 (시작 배치는 없음) */
  player: string | null;
  events: GameEvent[];
}

/** 기록을 턴별로 묶는다 (최근 턴이 위로). 턴을 둔 사람은 그 턴의 굴림·발전 카드·턴 넘기기 기록에서 찾는다 (버리기 시간 초과처럼 남이 한 일은 보지 않는다). */
export function groupByTurn(events: readonly GameEvent[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const e of events) {
    let cur = groups[groups.length - 1];
    if (!cur || cur.turn !== e.turn) {
      cur = { turn: e.turn, player: null, events: [] };
      groups.push(cur);
    }
    if (cur.player === null && e.turn > 0 && (e.kind === 'roll' || e.kind === 'turn_end' || e.kind === 'play_dev')) cur.player = e.player;
    cur.events.push(e);
  }
  return groups.reverse();
}
