// 강줄기 교역로 규칙 엔진.
// 서버만 이 모듈로 상태를 바꾼다. 브라우저는 같은 함수를 버튼 활성화 같은 안내용으로만 쓴다.
// 모든 행동은 "검사를 전부 끝낸 뒤 상태를 바꾼다" 원칙을 지켜, 거절된 요청이 상태를 건드리지 않게 한다.

import {
  ACTIONS_PER_TURN,
  BUILD_COST,
  CONTRACT_MAP,
  FORECAST,
  MARKET_GET,
  MARKET_GIVE,
  MAX_PLAYERS,
  MAX_SETTLEMENTS,
  MAX_TRADE_AMOUNT,
  MIN_PLAYERS,
  NEIGHBORS,
  RESOURCES,
  RESOURCE_LABEL,
  START_RESOURCES,
  TILES,
  TILE_MAP,
  TOTAL_ROUNDS,
  bundleTotal,
  emptyBundle,
  hasBundle,
} from './constants';
import type {
  Bundle,
  ContractId,
  GameAction,
  GameEvent,
  GamePhase,
  GameResult,
  NewGameEvent,
  RankEntry,
  Resource,
  Settlement,
  TileId,
  TradeCloseReason,
  TradeOffer,
} from './types';

export interface PlayerGameState {
  id: string;
  resources: Bundle;
  score: number;
}

export interface GameState {
  phase: GamePhase;
  /** 서버가 섞은 자리 순서 */
  order: string[];
  /** 시작 배치를 마친 사람 수 (배치는 마지막 자리부터 역순) */
  placementIndex: number;
  /** 시작 배치 중에는 0, 진행 중에는 1~6 */
  round: number;
  /** 이번 라운드에서 몇 번째 턴인지 (0부터) */
  turnInRound: number;
  actionsLeft: number;
  players: Record<string, PlayerGameState>;
  settlements: Settlement[];
  /** 이번 라운드에 완료된 계약과 완료한 사람 */
  contractsDone: Partial<Record<ContractId, string>>;
  trade: TradeOffer | null;
  tradeSeq: number;
  events: GameEvent[];
  eventSeq: number;
  result: GameResult | null;
  /** 상태가 바뀔 때마다 1씩 증가 */
  version: number;
}

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'WRONG_PHASE'
  | 'NOT_YOUR_TURN'
  | 'NO_ACTIONS'
  | 'NOT_ENOUGH'
  | 'TILE_INVALID'
  | 'TILE_TAKEN'
  | 'NOT_ADJACENT'
  | 'LIMIT'
  | 'CONTRACT_CLOSED'
  | 'TRADE_OPEN'
  | 'TRADE_INVALID'
  | 'TRADE_GONE'
  | 'NOT_ALLOWED';

export type ActionResult = { ok: true } | { ok: false; code: ErrorCode; message: string };

const OK: ActionResult = { ok: true };

function fail(code: ErrorCode, message: string): ActionResult {
  return { ok: false, code, message };
}

/** Fisher–Yates. random 은 [0, 1) 값을 돌려주는 함수 */
export function shuffle<T>(items: T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createGame(playerIds: string[], random: () => number = Math.random): GameState {
  if (playerIds.length < MIN_PLAYERS || playerIds.length > MAX_PLAYERS) {
    throw new Error(`플레이어는 ${MIN_PLAYERS}~${MAX_PLAYERS}명이어야 합니다.`);
  }
  if (new Set(playerIds).size !== playerIds.length) throw new Error('플레이어 ID가 중복되었습니다.');
  const order = shuffle(playerIds, random);
  const players: Record<string, PlayerGameState> = {};
  for (const id of order) players[id] = { id, resources: { ...START_RESOURCES }, score: 0 };
  const state: GameState = {
    phase: 'placement',
    order,
    placementIndex: 0,
    round: 0,
    turnInRound: 0,
    actionsLeft: 0,
    players,
    settlements: [],
    contractsDone: {},
    trade: null,
    tradeSeq: 0,
    events: [],
    eventSeq: 0,
    result: null,
    version: 1,
  };
  pushEvent(state, { kind: 'game_start', order: [...order] });
  return state;
}

function pushEvent(s: GameState, e: NewGameEvent): void {
  s.eventSeq += 1;
  s.events.push({ ...e, seq: s.eventSeq, round: s.round } as GameEvent);
}

// ───────────────────────── 조회 함수 ─────────────────────────

export function placementOrder(s: GameState): string[] {
  return [...s.order].reverse();
}

export function placementPlayer(s: GameState): string | null {
  if (s.phase !== 'placement') return null;
  return placementOrder(s)[s.placementIndex] ?? null;
}

export function firstSeatOfRound(round: number, playerCount: number): number {
  return (((round - 1) % playerCount) + playerCount) % playerCount;
}

export function firstPlayer(s: GameState): string | null {
  if (s.phase !== 'playing') return null;
  return s.order[firstSeatOfRound(s.round, s.order.length)];
}

export function currentPlayer(s: GameState): string | null {
  if (s.phase !== 'playing') return null;
  const n = s.order.length;
  return s.order[(firstSeatOfRound(s.round, n) + s.turnInRound) % n];
}

/** 이번 라운드의 턴 순서 (선 플레이어부터) */
export function roundTurnOrder(order: string[], round: number): string[] {
  const n = order.length;
  const first = firstSeatOfRound(Math.max(1, round), n);
  return order.map((_, i) => order[(first + i) % n]);
}

export function tileOwner(settlements: readonly Settlement[], tileId: TileId): string | null {
  return settlements.find((st) => st.tileId === tileId)?.owner ?? null;
}

export function settlementsOf(settlements: readonly Settlement[], playerId: string): Settlement[] {
  return settlements.filter((st) => st.owner === playerId);
}

export function isProductionTile(tileId: TileId): boolean {
  const t = TILE_MAP[tileId];
  return !!t && t.kind !== 'market';
}

/** 시작 거점을 놓을 수 있는 칸: 비어 있는 모든 생산 칸 */
export function placeableTiles(settlements: readonly Settlement[]): TileId[] {
  return TILES.filter((t) => t.kind !== 'market' && !tileOwner(settlements, t.id)).map((t) => t.id);
}

/** 자기 거점과 변을 맞댄 빈 생산 칸 (비용·보유 한도는 따로 확인) */
export function buildableTiles(settlements: readonly Settlement[], playerId: string): TileId[] {
  const mine = settlementsOf(settlements, playerId);
  const result = new Set<TileId>();
  for (const st of mine) {
    for (const n of NEIGHBORS[st.tileId] ?? []) {
      if (isProductionTile(n) && !tileOwner(settlements, n)) result.add(n);
    }
  }
  return TILES.map((t) => t.id).filter((id) => result.has(id));
}

/** 라운드 시작 공동 생산량 계산 (README: 거점마다 1개, 예보와 같은 종류면 1개 추가) */
export function productionFor(settlements: readonly Settlement[], round: number, playerIds: readonly string[]): Record<string, Bundle> {
  const forecast = FORECAST[round - 1];
  const gains: Record<string, Bundle> = {};
  for (const id of playerIds) gains[id] = emptyBundle();
  for (const st of settlements) {
    const kind = TILE_MAP[st.tileId]?.kind;
    if (!kind || kind === 'market' || !gains[st.owner]) continue;
    gains[st.owner][kind] += 1 + (kind === forecast ? 1 : 0);
  }
  return gains;
}

// ───────────────────────── 행동 처리 ─────────────────────────

export function applyAction(s: GameState, playerId: string, action: GameAction): ActionResult {
  if (!s.players[playerId]) return fail('NOT_ALLOWED', '이 게임의 참가자가 아닙니다.');
  if (s.phase === 'finished') return fail('WRONG_PHASE', '게임이 이미 끝났습니다.');
  const eventsBefore = s.eventSeq;
  let result: ActionResult;
  switch (action.type) {
    case 'place':
      result = doPlace(s, playerId, action.tileId);
      break;
    case 'build':
      result = doBuild(s, playerId, action.tileId);
      break;
    case 'market':
      result = doMarket(s, playerId, action.give, action.get);
      break;
    case 'deliver':
      result = doDeliver(s, playerId, action.contractId);
      break;
    case 'trade_propose':
      result = doTradePropose(s, playerId, action.to, action.give, action.get);
      break;
    case 'trade_accept':
      result = doTradeAccept(s, playerId, action.tradeId);
      break;
    case 'trade_reject':
      result = doTradeReject(s, playerId, action.tradeId);
      break;
    case 'trade_cancel':
      result = doTradeCancel(s, playerId, action.tradeId);
      break;
    case 'end_turn':
      result = doEndTurn(s, playerId);
      break;
    default:
      result = fail('BAD_REQUEST', '알 수 없는 행동입니다.');
  }
  // 상태를 바꾸는 처리는 모두 기록을 남기므로, 기록 번호로 변경 여부를 판단한다.
  // (수락 실패와 함께 제안이 닫히는 경우처럼, 거절된 요청이 상태를 바꾸는 예외도 포함된다.)
  if (s.eventSeq !== eventsBefore) s.version += 1;
  return result;
}

function checkTileForSettlement(s: GameState, tileId: TileId): ActionResult | null {
  const tile = TILE_MAP[tileId];
  if (!tile) return fail('TILE_INVALID', '보드에 없는 칸입니다.');
  if (tile.kind === 'market') return fail('TILE_INVALID', '시장 칸에는 거점을 놓을 수 없습니다.');
  if (tileOwner(s.settlements, tileId)) return fail('TILE_TAKEN', '이미 거점이 있는 칸입니다.');
  return null;
}

function doPlace(s: GameState, playerId: string, tileId: TileId): ActionResult {
  if (s.phase !== 'placement') return fail('WRONG_PHASE', '시작 배치 단계가 아닙니다.');
  if (placementPlayer(s) !== playerId) return fail('NOT_YOUR_TURN', '지금은 다른 사람이 시작 거점을 놓을 차례입니다.');
  const bad = checkTileForSettlement(s, tileId);
  if (bad) return bad;

  s.settlements.push({ tileId, owner: playerId, builtRound: 0 });
  pushEvent(s, { kind: 'placement', player: playerId, tileId });
  s.placementIndex += 1;
  if (s.placementIndex >= s.order.length) startRound(s, 1);
  return OK;
}

function requireActiveTurn(s: GameState, playerId: string): ActionResult | null {
  if (s.phase !== 'playing') return fail('WRONG_PHASE', '아직 라운드가 시작되지 않았습니다.');
  if (currentPlayer(s) !== playerId) return fail('NOT_YOUR_TURN', '내 차례가 아닙니다.');
  if (s.actionsLeft <= 0) return fail('NO_ACTIONS', '이번 턴의 행동 2회를 모두 사용했습니다. 턴을 끝내 주세요.');
  return null;
}

function doBuild(s: GameState, playerId: string, tileId: TileId): ActionResult {
  const turnErr = requireActiveTurn(s, playerId);
  if (turnErr) return turnErr;
  const bad = checkTileForSettlement(s, tileId);
  if (bad) return bad;
  if (settlementsOf(s.settlements, playerId).length >= MAX_SETTLEMENTS) {
    return fail('LIMIT', `거점은 시작 거점을 포함해 최대 ${MAX_SETTLEMENTS}개까지 가질 수 있습니다.`);
  }
  if (!buildableTiles(s.settlements, playerId).includes(tileId)) {
    return fail('NOT_ADJACENT', '내 거점과 변을 맞댄 빈 생산 칸에만 지을 수 있습니다.');
  }
  const me = s.players[playerId];
  if (!hasBundle(me.resources, BUILD_COST)) return fail('NOT_ENOUGH', '거점 건설에는 목재 1개와 석재 1개가 필요합니다.');

  pay(me.resources, BUILD_COST);
  s.settlements.push({ tileId, owner: playerId, builtRound: s.round });
  s.actionsLeft -= 1;
  pushEvent(s, { kind: 'build', player: playerId, tileId });
  afterAction(s);
  return OK;
}

function doMarket(s: GameState, playerId: string, give: Resource, get: Resource): ActionResult {
  const turnErr = requireActiveTurn(s, playerId);
  if (turnErr) return turnErr;
  if (!RESOURCES.includes(give) || !RESOURCES.includes(get)) return fail('BAD_REQUEST', '자원 종류가 올바르지 않습니다.');
  if (give === get) return fail('BAD_REQUEST', '내는 자원과 받는 자원은 서로 달라야 합니다.');
  const me = s.players[playerId];
  if (me.resources[give] < MARKET_GIVE) {
    return fail('NOT_ENOUGH', `시장 교환에는 ${RESOURCE_LABEL[give]} ${MARKET_GIVE}개가 필요합니다.`);
  }

  me.resources[give] -= MARKET_GIVE;
  me.resources[get] += MARKET_GET;
  s.actionsLeft -= 1;
  pushEvent(s, { kind: 'market', player: playerId, detail: { give, get } });
  afterAction(s);
  return OK;
}

function doDeliver(s: GameState, playerId: string, contractId: ContractId): ActionResult {
  const turnErr = requireActiveTurn(s, playerId);
  if (turnErr) return turnErr;
  const contract = CONTRACT_MAP[contractId];
  if (!contract) return fail('BAD_REQUEST', '없는 계약입니다.');
  if (s.contractsDone[contractId]) return fail('CONTRACT_CLOSED', '이번 라운드에 이미 완료된 계약입니다.');
  const me = s.players[playerId];
  if (!hasBundle(me.resources, contract.cost)) return fail('NOT_ENOUGH', `${contract.name}에 필요한 자원이 부족합니다.`);

  pay(me.resources, contract.cost);
  me.score += contract.points;
  s.contractsDone[contractId] = playerId;
  s.actionsLeft -= 1;
  pushEvent(s, { kind: 'deliver', player: playerId, contractId, points: contract.points });
  afterAction(s);
  return OK;
}

export function validateTradeBundles(give: Bundle, get: Bundle): string | null {
  for (const r of RESOURCES) {
    for (const b of [give, get]) {
      if (!Number.isInteger(b[r]) || b[r] < 0 || b[r] > MAX_TRADE_AMOUNT) return '교환 수량이 올바르지 않습니다.';
    }
  }
  if (bundleTotal(give) < 1 || bundleTotal(get) < 1) return '양쪽 모두 자원을 1개 이상 내야 합니다.';
  if (RESOURCES.some((r) => give[r] > 0 && get[r] > 0)) return '같은 종류의 자원을 양쪽에 함께 넣을 수 없습니다.';
  return null;
}

function doTradePropose(s: GameState, playerId: string, to: string, give: Bundle, get: Bundle): ActionResult {
  const turnErr = requireActiveTurn(s, playerId);
  if (turnErr) return turnErr;
  if (s.trade) return fail('TRADE_OPEN', '이미 열린 교환 제안이 있습니다. 응답을 기다리거나 취소하세요.');
  // 'constructor' 같은 이름이 객체 기본 속성으로 통과하지 않도록 자기 속성인지 확인한다.
  if (to === playerId || !Object.prototype.hasOwnProperty.call(s.players, to)) {
    return fail('TRADE_INVALID', '교환할 상대를 다시 고르세요.');
  }
  const bundleErr = validateTradeBundles(give, get);
  if (bundleErr) return fail('TRADE_INVALID', bundleErr);
  const me = s.players[playerId];
  // 상대 보유량은 여기서 확인하지 않는다. 확인 결과가 상대의 비공개 자원을 드러내기 때문이다.
  if (!hasBundle(me.resources, give)) return fail('NOT_ENOUGH', '제안한 자원을 모두 가지고 있지 않습니다.');

  s.tradeSeq += 1;
  s.trade = { id: s.tradeSeq, from: playerId, to, give: { ...give }, get: { ...get } };
  pushEvent(s, {
    kind: 'trade_proposed',
    from: playerId,
    to,
    tradeId: s.tradeSeq,
    detail: { give: { ...give }, get: { ...get } },
  });
  return OK;
}

function closeTrade(s: GameState, reason: TradeCloseReason): void {
  const t = s.trade;
  if (!t) return;
  s.trade = null;
  pushEvent(s, { kind: 'trade_closed', from: t.from, to: t.to, tradeId: t.id, reason });
}

function doTradeAccept(s: GameState, playerId: string, tradeId: number): ActionResult {
  if (s.phase !== 'playing') return fail('WRONG_PHASE', '지금은 교환할 수 없습니다.');
  const t = s.trade;
  // 같은 제안을 두 번 수락하면 두 번째 요청은 여기서 거절된다 (제안이 이미 닫혔기 때문).
  if (!t || t.id !== tradeId) return fail('TRADE_GONE', '이미 처리되었거나 닫힌 교환 제안입니다.');
  if (t.to !== playerId) return fail('NOT_ALLOWED', '교환 제안을 받은 사람만 수락할 수 있습니다.');
  const from = s.players[t.from];
  const me = s.players[playerId];
  if (currentPlayer(s) !== t.from || s.actionsLeft <= 0) {
    closeTrade(s, 'no_actions');
    return { ok: false, code: 'TRADE_GONE', message: '제안한 사람의 행동이 남아 있지 않아 교환이 닫혔습니다.' };
  }
  if (!hasBundle(from.resources, t.give)) {
    closeTrade(s, 'unaffordable');
    return { ok: false, code: 'TRADE_GONE', message: '제안한 사람의 자원이 바뀌어 교환이 닫혔습니다.' };
  }
  if (!hasBundle(me.resources, t.get)) return fail('NOT_ENOUGH', '요청받은 자원이 부족해 수락할 수 없습니다.');

  pay(from.resources, t.give);
  gain(me.resources, t.give);
  pay(me.resources, t.get);
  gain(from.resources, t.get);
  s.trade = null;
  s.actionsLeft -= 1;
  pushEvent(s, {
    kind: 'trade_accepted',
    from: t.from,
    to: t.to,
    tradeId: t.id,
    detail: { give: { ...t.give }, get: { ...t.get } },
  });
  afterAction(s);
  return OK;
}

function doTradeReject(s: GameState, playerId: string, tradeId: number): ActionResult {
  const t = s.trade;
  if (!t || t.id !== tradeId) return fail('TRADE_GONE', '이미 처리되었거나 닫힌 교환 제안입니다.');
  if (t.to !== playerId) return fail('NOT_ALLOWED', '교환 제안을 받은 사람만 거절할 수 있습니다.');
  closeTrade(s, 'rejected');
  return OK;
}

function doTradeCancel(s: GameState, playerId: string, tradeId: number): ActionResult {
  const t = s.trade;
  if (!t || t.id !== tradeId) return fail('TRADE_GONE', '이미 처리되었거나 닫힌 교환 제안입니다.');
  if (t.from !== playerId) return fail('NOT_ALLOWED', '제안한 사람만 취소할 수 있습니다.');
  closeTrade(s, 'cancelled');
  return OK;
}

function doEndTurn(s: GameState, playerId: string): ActionResult {
  if (s.phase !== 'playing') return fail('WRONG_PHASE', '아직 라운드가 시작되지 않았습니다.');
  if (currentPlayer(s) !== playerId) return fail('NOT_YOUR_TURN', '내 차례가 아닙니다.');
  if (s.trade) closeTrade(s, 'turn_end');
  pushEvent(s, { kind: 'turn_end', player: playerId });
  s.turnInRound += 1;
  if (s.turnInRound >= s.order.length) {
    if (s.round >= TOTAL_ROUNDS) finishGame(s);
    else startRound(s, s.round + 1);
  } else {
    s.actionsLeft = ACTIONS_PER_TURN;
  }
  return OK;
}

/** 차례인 사람이 행동한 뒤, 열린 제안이 더는 성립할 수 없으면 닫는다. */
function afterAction(s: GameState): void {
  const t = s.trade;
  if (!t) return;
  if (s.actionsLeft <= 0) closeTrade(s, 'no_actions');
  else if (!hasBundle(s.players[t.from].resources, t.give)) closeTrade(s, 'unaffordable');
}

function startRound(s: GameState, round: number): void {
  s.phase = 'playing';
  s.round = round;
  s.turnInRound = 0;
  s.actionsLeft = ACTIONS_PER_TURN;
  s.contractsDone = {};
  s.trade = null;
  const detail = productionFor(s.settlements, round, s.order);
  const gains: Record<string, number> = {};
  for (const id of s.order) {
    gain(s.players[id].resources, detail[id]);
    gains[id] = bundleTotal(detail[id]);
  }
  pushEvent(s, {
    kind: 'round_start',
    firstPlayer: s.order[firstSeatOfRound(round, s.order.length)],
    forecast: FORECAST[round - 1],
    gains,
    detail,
  });
}

function finishGame(s: GameState): void {
  s.phase = 'finished';
  s.actionsLeft = 0;
  s.trade = null;
  s.result = computeResult(s);
  pushEvent(s, { kind: 'game_end', winners: [...s.result.winners] });
}

/** 납품 점수 → 남은 자원 총량 순으로 순위를 매긴다. 둘 다 같으면 같은 순위(공동 승리). */
export function computeResult(s: Pick<GameState, 'order' | 'players'>): GameResult {
  const entries = s.order.map((id) => ({
    playerId: id,
    score: s.players[id].score,
    resourceTotal: bundleTotal(s.players[id].resources),
    rank: 0,
  }));
  for (const e of entries) {
    e.rank =
      1 +
      entries.filter((o) => o.score > e.score || (o.score === e.score && o.resourceTotal > e.resourceTotal)).length;
  }
  const ranking: RankEntry[] = [...entries].sort(
    (a, b) => a.rank - b.rank || s.order.indexOf(a.playerId) - s.order.indexOf(b.playerId),
  );
  const winners = ranking.filter((e) => e.rank === 1).map((e) => e.playerId);
  const topScore = Math.max(...entries.map((e) => e.score));
  const tiedTop = entries.filter((e) => e.score === topScore).length;
  const decidedBy = winners.length > 1 ? 'joint' : tiedTop > 1 ? 'resources' : 'score';
  return { ranking, winners, decidedBy };
}

function pay(have: Bundle, cost: Bundle): void {
  for (const r of RESOURCES) have[r] -= cost[r];
}

function gain(have: Bundle, add: Bundle): void {
  for (const r of RESOURCES) have[r] += add[r];
}
