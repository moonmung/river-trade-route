// 각 브라우저에 보낼 게임 화면 정보를 만든다 (서버와 실험실 모의 게임이 함께 쓴다).
// 공개 정보와 "그 참가자 자신의" 비공개 자원만 넣는다. 다른 사람의 종류별 자원은 절대 넣지 않는다.
import { boardOf } from './board';
import { PIECE_LIMIT, bundleTotal, emptyBundle } from './constants';
import type { GameView } from './protocol';
import {
  clockHolders,
  currentPlayer,
  longestRoadLength,
  pieceCount,
  placementOrder,
  placementPlayer,
  tradeRatios,
  victoryPoints,
  type GameState,
} from './rules';
import type { GameEvent } from './types';

/** 화면에 보내는 최근 기록 수 */
const EVENT_WINDOW = 80;

export function filterEventFor(e: GameEvent, viewer: string): GameEvent {
  switch (e.kind) {
    case 'roll': {
      const { detail, ...rest } = e;
      return detail && detail[viewer] ? { ...rest, detail: { [viewer]: { ...detail[viewer] } } } : rest;
    }
    case 'discard':
    case 'gold_pick':
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

/** 차례 시계: 방장이 정한 제한 시간과 지금 마감 시각 (멈춰 있으면 null) */
export interface ClockInfo {
  turnSeconds: number;
  deadline: number | null;
}

export function buildGameView(g: GameState, viewer: string, clock: ClockInfo = { turnSeconds: 0, deadline: null }, now = Date.now()): GameView {
  const me = g.players[viewer];
  return {
    phase: g.phase,
    turn: g.turn,
    order: [...g.order],
    startRolls: Object.fromEntries(Object.entries(g.startRolls).map(([id, rolls]) => [id, rolls.map((d) => [d[0], d[1]] as [number, number])])),
    startPending: [...g.startPending],
    placementOrder: placementOrder(g),
    placementPlayerId: placementPlayer(g),
    setupVillage: g.setupVillage,
    handLimit: g.handLimit,
    turnSeconds: clock.turnSeconds,
    clockHolders: clockHolders(g),
    timeLeftMs: clock.deadline === null ? null : Math.max(0, clock.deadline - now),
    currentPlayerId: currentPlayer(g),
    step: g.step,
    dice: g.dice ? [g.dice[0], g.dice[1]] : null,
    discards: { ...g.discards },
    stealFrom: [...g.stealFrom],
    tiles: g.tiles.map((t) => ({ ...t })),
    sea: (g.sea ?? []).map((c) => ({ ...c })),
    bank: g.bank ? { ...g.bank } : null,
    bankSize: g.bankSize,
    robber: g.robber,
    numbers: { ...g.numbers },
    harbors: g.harbors.map((h) => ({ ...h })),
    buildings: g.buildings.map((b) => ({ ...b })),
    roads: g.roads.map((r) => ({ ...r })),
    ships: (g.ships ?? []).map((sh) => ({ ...sh })),
    shipMoved: !!g.shipMoved,
    pirate: g.pirate ?? null,
    goldPicks: { ...(g.goldPicks ?? {}) },
    islandClaims: { ...(g.islandClaims ?? {}) },
    devDeckCount: g.devDeck.length,
    unlimited: !!g.unlimited,
    diceMode: g.diceMode ?? 'random',
    sevenDiscard: g.sevenDiscard !== false,
    longestRoadAward: g.longestRoadAward !== false,
    largestArmyAward: g.largestArmyAward !== false,
    pieceLimits: { ...(g.pieceLimits ?? PIECE_LIMIT) },
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
      roadLength: longestRoadLength(boardOf(g), g.roads, g.buildings, id, g.ships ?? []),
      villages: pieceCount(g.buildings, g.roads, id, 'village'),
      cities: pieceCount(g.buildings, g.roads, id, 'city'),
      roads: pieceCount(g.buildings, g.roads, id, 'road'),
      ships: pieceCount(g.buildings, g.roads, id, 'ship', g.ships ?? []),
      islands: g.islandBonus?.[id]?.length ?? 0,
    })),
    myResources: me ? { ...me.resources } : emptyBundle(),
    myDevCards: me ? me.devCards.map((c) => ({ ...c })) : [],
    myTradeRatios: tradeRatios(g, viewer),
    myPoints: me ? victoryPoints(g, viewer, true) : 0,
    trades: g.trades.map((t) => ({ id: t.id, from: t.from, to: [...t.to], give: { ...t.give }, get: { ...t.get }, responses: { ...t.responses } })),
    events: g.events.slice(-EVENT_WINDOW).map((e) => filterEventFor(e, viewer)),
    result: g.result ? structuredClone(g.result) : null,
    winPoints: g.winPoints,
    version: g.version,
  };
}

