// 각 브라우저에 보낼 화면 정보를 만든다.
// 공개 정보와 "그 참가자 자신의" 비공개 자원만 넣는다. 다른 사람의 종류별 자원은 절대 넣지 않는다.
import { MAX_PLAYERS, MIN_PLAYERS, bundleTotal, emptyBundle } from '../shared/constants';
import type { GameView, RoomView } from '../shared/protocol';
import {
  currentPlayer,
  longestRoadLength,
  pieceCount,
  placementOrder,
  placementPlayer,
  tradeRatios,
  victoryPoints,
  type GameState,
} from '../shared/rules';
import type { GameEvent } from '../shared/types';
import type { Room } from './rooms';

/** 화면에 보내는 최근 기록 수 */
const EVENT_WINDOW = 80;

export function filterEventFor(e: GameEvent, viewer: string): GameEvent {
  switch (e.kind) {
    case 'roll': {
      const { detail, ...rest } = e;
      return detail && detail[viewer] ? { ...rest, detail: { [viewer]: { ...detail[viewer] } } } : rest;
    }
    case 'discard':
    case 'buy_dev': {
      if (e.player === viewer) return e;
      const { detail: _hidden, ...rest } = e;
      return rest;
    }
    case 'steal': {
      if (e.player === viewer || e.from === viewer) return e;
      const { detail: _hidden, ...rest } = e;
      return rest;
    }
    // 교환 제안·성사 내용은 모두에게 공개한다 (모두에게 한 번에 제안하므로). 종류별 보유량은 기록에 없다.
    default:
      return e;
  }
}

export function buildGameView(g: GameState, viewer: string): GameView {
  const t = g.trade;
  const me = g.players[viewer];
  return {
    phase: g.phase,
    turn: g.turn,
    order: [...g.order],
    placementOrder: placementOrder(g),
    placementPlayerId: placementPlayer(g),
    currentPlayerId: currentPlayer(g),
    step: g.step,
    dice: g.dice ? [g.dice[0], g.dice[1]] : null,
    discards: { ...g.discards },
    stealFrom: [...g.stealFrom],
    robber: g.robber,
    numbers: { ...g.numbers },
    harbors: g.harbors.map((h) => ({ ...h })),
    buildings: g.buildings.map((b) => ({ ...b })),
    roads: g.roads.map((r) => ({ ...r })),
    devDeckCount: g.devDeck.length,
    devPlayedThisTurn: g.devPlayedThisTurn,
    freeRoads: g.freeRoads,
    longestRoad: { ...g.longestRoad },
    largestArmy: { ...g.largestArmy },
    players: g.order.map((id, seat) => ({
      id,
      seat,
      score: victoryPoints(g, id, g.phase === 'finished'),
      resourceTotal: bundleTotal(g.players[id].resources),
      devCardCount: g.players[id].devCards.length,
      knightsPlayed: g.players[id].knightsPlayed,
      roadLength: longestRoadLength(g.roads, g.buildings, id),
      villages: pieceCount(g.buildings, g.roads, id, 'village'),
      cities: pieceCount(g.buildings, g.roads, id, 'city'),
      roads: pieceCount(g.buildings, g.roads, id, 'road'),
    })),
    myResources: me ? { ...me.resources } : emptyBundle(),
    myDevCards: me ? me.devCards.map((c) => ({ ...c })) : [],
    myTradeRatios: tradeRatios(g, viewer),
    myPoints: me ? victoryPoints(g, viewer, true) : 0,
    trade: t ? { id: t.id, from: t.from, to: [...t.to], give: { ...t.give }, get: { ...t.get }, responses: { ...t.responses } } : null,
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
