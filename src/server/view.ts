// 각 브라우저에 보낼 화면 정보를 만든다.
// 공개 정보와 "그 참가자 자신의" 비공개 자원만 넣는다. 다른 사람의 종류별 자원은 절대 넣지 않는다.
import { CONTRACTS, FORECAST, MAX_PLAYERS, MIN_PLAYERS, TOTAL_ROUNDS, bundleTotal, emptyBundle } from '../shared/constants';
import type { GameView, RoomView } from '../shared/protocol';
import {
  currentPlayer,
  firstPlayer,
  placementOrder,
  placementPlayer,
  settlementsOf,
  type GameState,
} from '../shared/rules';
import type { GameEvent } from '../shared/types';
import type { Room } from './rooms';

/** 화면에 보내는 최근 기록 수 */
const EVENT_WINDOW = 80;

export function filterEventFor(e: GameEvent, viewer: string): GameEvent {
  switch (e.kind) {
    case 'round_start': {
      const { detail, ...rest } = e;
      return detail && detail[viewer] ? { ...rest, detail: { [viewer]: { ...detail[viewer] } } } : rest;
    }
    case 'market': {
      if (e.player === viewer) return e;
      const { detail: _hidden, ...rest } = e;
      return rest;
    }
    case 'trade_proposed':
    case 'trade_accepted': {
      if (e.from === viewer || e.to === viewer) return e;
      const { detail: _hidden, ...rest } = e;
      return rest;
    }
    default:
      return e;
  }
}

export function buildGameView(g: GameState, viewer: string): GameView {
  const t = g.trade;
  const isParty = !!t && (t.from === viewer || t.to === viewer);
  return {
    phase: g.phase,
    round: g.round,
    totalRounds: TOTAL_ROUNDS,
    forecast: [...FORECAST],
    order: [...g.order],
    placementOrder: placementOrder(g),
    placementPlayerId: placementPlayer(g),
    firstPlayerId: firstPlayer(g),
    currentPlayerId: currentPlayer(g),
    actionsLeft: g.actionsLeft,
    settlements: g.settlements.map((s) => ({ ...s })),
    contracts: CONTRACTS.map((c) => ({ id: c.id, completedBy: g.contractsDone[c.id] ?? null })),
    players: g.order.map((id, seat) => ({
      id,
      seat,
      score: g.players[id].score,
      resourceTotal: bundleTotal(g.players[id].resources),
      settlementCount: settlementsOf(g.settlements, id).length,
    })),
    myResources: g.players[viewer] ? { ...g.players[viewer].resources } : emptyBundle(),
    trade: t
      ? isParty
        ? { id: t.id, from: t.from, to: t.to, give: { ...t.give }, get: { ...t.get } }
        : { id: t.id, from: t.from, to: t.to }
      : null,
    events: g.events.slice(-EVENT_WINDOW).map((e) => filterEventFor(e, viewer)),
    result: g.result ? structuredClone(g.result) : null,
    version: g.version,
  };
}

export function buildRoomView(room: Room, viewer: string): RoomView {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    you: viewer,
    players: room.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      colorIndex: p.colorIndex,
      isHost: p.id === room.hostId,
      ready: p.ready,
      connected: p.connected,
    })),
    game: room.game ? buildGameView(room.game, viewer) : null,
    gameNumber: room.gameNumber,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
  };
}
