// 실험실 모의 게임의 봇. tests/helpers.ts 의 봇과 같은 규칙에 순서 주사위, 마을 → 길 시작 배치, 교환 응답을 더했다.
// 화면 정보(RoomView)만 보고 고르므로 실제 참가자가 볼 수 있는 것 이상은 쓰지 않는다.
import { boardOf } from '../../shared/board';
import { DEV_COST, PIECE_COST, RESOURCES, emptyBundle, hasBundle, numberPips } from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import { buildableRoads, buildableVillages, pieceCount, pieceLimit, placeableVertices, setupRoadEdges, upgradableVillages } from '../../shared/rules';
import type { GameAction } from '../../shared/types';

/** 차례가 아니어도 해야 하는 일 (순서 주사위, 7 버리기, 받은 교환 제안에 답하기). 없으면 null. */
export function botSideAction(v: RoomView, random: () => number = Math.random): GameAction | null {
  const g = v.game!;
  const me = v.you;
  if (g.phase === 'order') return g.startPending.includes(me) ? { type: 'order_roll' } : null;
  if (g.phase !== 'playing') return null;
  if (g.step === 'discard' && g.discards[me]) {
    // 가장 많은 자원부터 하나씩 버린다
    const left = { ...g.myResources };
    const out = emptyBundle();
    for (let i = 0; i < g.discards[me]; i++) {
      const most = RESOURCES.reduce((a, b) => (left[a] >= left[b] ? a : b));
      left[most] -= 1;
      out[most] += 1;
    }
    return { type: 'discard', bundle: out };
  }
  for (const t of g.trades) {
    if (t.from === me || !t.to.includes(me) || t.responses[me] !== 'pending') continue;
    // 낼 수 있으면 대개 받아들이고, 가끔은 거절한다
    const can = hasBundle(g.myResources, t.get);
    return can && random() < 0.75 ? { type: 'trade_accept', tradeId: t.id } : { type: 'trade_reject', tradeId: t.id };
  }
  return null;
}

/** 차례인 봇의 다음 행동. 매 행동이 자원을 쓰거나 단계를 넘기므로 같은 턴에 끝없이 돌지 않는다. */
export function botTurnAction(v: RoomView, seat: number, random: () => number = Math.random): GameAction | null {
  const g = v.game!;
  const board = boardOf(g);
  const me = v.you;
  const r = g.myResources;
  if (g.phase === 'placement') {
    if (g.placementPlayerId !== me) return null;
    if (g.setupVillage) {
      const edges = setupRoadEdges(board, g.roads, g.setupVillage);
      return { type: 'place_road', edgeId: edges[Math.floor(random() * edges.length)] };
    }
    // 점(나올 확률)이 많은 자리 중에서 고른다
    const free = placeableVertices(board, g.buildings);
    const pips = (id: string) => board.vertexMap[id].tiles.reduce((n, t) => n + (g.numbers[t] ? numberPips(g.numbers[t]) : 0), 0);
    const ranked = [...free].sort((a, b) => pips(b) - pips(a));
    const top = ranked.slice(0, Math.max(3, Math.ceil(ranked.length / 8)));
    return { type: 'place_village', vertexId: top[Math.floor(random() * top.length)] };
  }
  if (g.phase !== 'playing' || g.currentPlayerId !== me) return null;
  if (g.step === 'discard') return null;
  if (g.step === 'roll') return { type: 'roll' };
  if (g.step === 'robber') {
    // 남의 마을이 많이 닿고 내 마을은 없는 칸
    const score = (tileId: string) =>
      g.buildings.filter((b) => board.vertexMap[b.vertexId].tiles.includes(tileId)).reduce((n, b) => n + (b.owner === me ? -10 : 1), 0);
    const tiles = g.tiles.map((t) => t.id).filter((id) => id !== g.robber);
    const best = tiles.reduce((a, b) => (score(b) > score(a) ? b : a), tiles[(seat * 5) % tiles.length]);
    return { type: 'move_robber', tileId: best };
  }
  if (g.step === 'steal') return { type: 'steal', from: g.stealFrom[Math.floor(random() * g.stealFrom.length)] };
  if (g.step === 'road_building') {
    const edges = buildableRoads(board, g.buildings, g.roads, me);
    return edges.length ? { type: 'build_road', edgeId: edges[Math.floor(random() * edges.length)] } : { type: 'end_turn' };
  }

  // 내가 낸 교환 제안에 수락한 사람이 있으면 확정하고, 오래 걸리면 거둔다.
  for (const t of g.trades.filter((x) => x.from === me)) {
    const yes = t.to.find((id) => t.responses[id] === 'accepted');
    if (yes) return { type: 'trade_confirm', tradeId: t.id, with: yes };
    if (t.to.every((id) => t.responses[id] !== 'pending')) return { type: 'trade_cancel', tradeId: t.id };
  }

  const count = (kind: 'road' | 'village' | 'city') => pieceCount(g.buildings, g.roads, me, kind);
  const playable = (kind: string) => !g.devPlayedThisTurn && g.myDevCards.some((c) => c.kind === kind && c.boughtTurn < g.turn);
  if (playable('knight') && g.buildings.some((b) => b.owner === me && board.vertexMap[b.vertexId].tiles.includes(g.robber))) {
    return { type: 'play_dev', kind: 'knight' };
  }
  if (hasBundle(r, PIECE_COST.city) && count('city') < pieceLimit(g, 'city')) {
    const villages = upgradableVillages(g.buildings, me);
    if (villages.length) return { type: 'build_city', vertexId: villages[0] };
  }
  const villageSpots = buildableVillages(board, g.buildings, g.roads, me);
  if (hasBundle(r, PIECE_COST.village) && count('village') < pieceLimit(g, 'village') && villageSpots.length) {
    return { type: 'build_village', vertexId: villageSpots[0] };
  }
  if (playable('road_building') && !villageSpots.length && buildableRoads(board, g.buildings, g.roads, me).length) return { type: 'play_dev', kind: 'road_building' };
  if (playable('year_of_plenty')) return { type: 'play_dev', kind: 'year_of_plenty', resources: ['stone', 'grain'] };
  if (playable('monopoly') && random() < 0.5) return { type: 'play_dev', kind: 'monopoly', resource: RESOURCES[Math.floor(random() * RESOURCES.length)] };
  if (hasBundle(r, DEV_COST) && (g.devDeckCount > 0 || g.unlimited)) return { type: 'buy_dev' };
  if (hasBundle(r, PIECE_COST.road) && count('road') < pieceLimit(g, 'road') && !villageSpots.length) {
    const edges = buildableRoads(board, g.buildings, g.roads, me);
    if (edges.length) return { type: 'build_road', edgeId: edges[(seat * 3 + g.turn) % edges.length] };
  }
  // 다음 목표(도시 → 마을 → 발전 카드)에 모자란 자원 하나를, 목표에 안 쓰는 남는 자원으로 바꾼다 (교역로가 있으면 교역로로).
  const target = count('village') > 0 && count('city') < pieceLimit(g, 'city') ? PIECE_COST.city : villageSpots.length ? PIECE_COST.village : DEV_COST;
  const missing = RESOURCES.find((x) => r[x] < target[x]);
  if (missing) {
    const give = RESOURCES.find((x) => x !== missing && r[x] - target[x] >= g.myTradeRatios[x]);
    if (give) return { type: 'bank_trade', give: { ...emptyBundle(), [give]: g.myTradeRatios[give] }, get: { ...emptyBundle(), [missing]: 1 } };
    // 남는 자원 1장으로 모두에게 1:1 교환을 제안해 본다 (턴마다 한 번)
    const spare = RESOURCES.find((x) => x !== missing && r[x] > target[x]);
    const proposedThisTurn = g.events.some((e) => e.kind === 'trade_proposed' && e.from === me && e.turn === g.turn);
    if (spare && !proposedThisTurn && random() < 0.6) {
      return { type: 'trade_propose', give: { ...emptyBundle(), [spare]: 1 }, get: { ...emptyBundle(), [missing]: 1 } };
    }
  }
  if (g.trades.some((t) => t.from === me && t.to.some((id) => t.responses[id] === 'pending'))) return null;
  return { type: 'end_turn' };
}
