// 데블스랜드 규칙 엔진 (카탄 기본 규칙).
// 서버만 이 모듈로 상태를 바꾼다. 브라우저는 같은 함수를 버튼 활성화 같은 안내용으로만 쓴다.
// 모든 행동은 "검사를 전부 끝낸 뒤 상태를 바꾼다" 원칙을 지켜, 거절된 요청이 상태를 건드리지 않게 한다.
// 주사위·빼앗기·발전 카드 섞기에 쓰는 난수는 바깥에서 넘겨받는다 (서버는 Math.random, 테스트는 고정 값).

import { boardOf, harborVertices, smallIslandAt, type Board, type BoardGeometry, type EdgeId, type SeaCellId, type SeaNet, type VertexId } from './board';
import { buildMap, DEFAULT_MAP, mapCardDefaults, maxPlayersFor } from './maps';
import { drawFairDice, newFairDice, recordProduction, type DiceMode, type FairDiceState } from './fairDice';
import {
  AWARD_POINTS,
  ISLAND_BONUS_POINTS,
  BANK_RATIO,
  DEV_COST,
  DEV_CARDS_MAX,
  DEV_CARDS_MIN,
  DEV_DECK,
  DEV_KIND_MAX,
  DEV_LABEL,
  DISCARD_LIMIT,
  HAND_LIMIT_MAX,
  HAND_LIMIT_MIN,
  GENERIC_HARBOR_RATIO,
  LARGEST_ARMY_MIN,
  LONGEST_ROAD_MIN,
  MAX_OPEN_TRADES,
  MAX_TRADE_AMOUNT,
  MIN_PLAYERS,
  PIECE_COST,
  PIECE_LABEL,
  PIECE_LIMIT,
  PIECE_POINTS,
  RESOURCES,
  RESOURCE_CARDS_MAX,
  RESOURCE_CARDS_MIN,
  RESOURCE_LABEL,
  SPECIAL_HARBOR_RATIO,
  WIN_POINTS,
  WIN_POINTS_MAX,
  WIN_POINTS_MIN,
  normalizeWinPoints,
  normalizeHandLimit,
  normalizeDevCards,
  normalizeDevMix,
  normalizePieceLimits,
  normalizeResourceCards,
  devDeckFor,
  numberPips,
  bundleLabel,
  bundleTotal,
  emptyBundle,
  hasBundle,
} from './constants';
import type { DevMix, PieceLimits } from './constants';
import type {
  Building,
  Bundle,
  DevCard,
  DevKind,
  GameAction,
  GameEvent,
  GamePhase,
  GameResult,
  Harbor,
  MapConfig,
  NewGameEvent,
  PieceKind,
  RankEntry,
  Resource,
  Road,
  SeaCell,
  Ship,
  TileDef,
  TileId,
  TradeCloseReason,
  TradeOffer,
  TradeResponse,
  TurnStep,
} from './types';

/** 바닷길이 있을 수도 있는 보드 (배 규칙은 sea 가 있을 때만 쓴다) */
type ShipBoard = BoardGeometry & { sea?: SeaNet | null };

export interface PlayerGameState {
  id: string;
  resources: Bundle;
  /** 손에 든 발전 카드 (승점 카드 포함). 다른 사람에게는 장수만 보인다. */
  devCards: DevCard[];
  /** 지금까지 쓴 기사 카드 수 (최강 기사단) */
  knightsPlayed: number;
}

export interface GameState {
  phase: GamePhase;
  /** 자리 순서. 순서 정하기(order) 단계에서는 참가 순서이고, 주사위로 정해지면 높은 사람부터 다시 놓인다. */
  order: string[];
  /** 순서 정하기 주사위 기록 (사람마다 굴린 순서대로). 같은 수가 나온 사람끼리는 한 번 더 굴려 뒤에 붙인다. */
  startRolls: Record<string, [number, number][]>;
  /** 순서 정하기에서 아직 굴려야 하는 사람 (처음엔 모두, 같은 수가 나오면 그 사람들만) */
  startPending: string[];
  /** 시작 배치를 몇 번 마쳤는지 (자리 순서대로 한 바퀴, 거꾸로 한 바퀴) */
  placementIndex: number;
  /** 시작 배치에서 마을만 지어 두고 길을 기다리는 꼭짓점 */
  setupVillage: VertexId | null;
  /** 자원 보유 한도: 7이 나오면 이보다 많이 든 사람이 절반을 버린다 (방장이 정한 값, 기본 7) */
  handLimit: number;
  /** 은행에 남은 자원 카드 (자원마다). null 이면 무제한이다 (장수를 정하기 전에 저장한 게임). */
  bank: Bundle | null;
  /** 게임을 시작할 때 은행에 둔 자원 카드 수 (자원마다, 무제한이면 null) */
  bankSize: number | null;
  /** 진행 턴 번호 (1부터). 시작 배치 중에는 0 */
  turn: number;
  /** 차례인 사람의 자리 번호 */
  current: number;
  step: TurnStep;
  /** 마지막으로 굴린 주사위 */
  dice: [number, number] | null;
  /** 7이 나와 아직 버려야 하는 장수 (다 버린 사람은 빠진다) */
  discards: Record<string, number>;
  /** 기사단 동상을 옮긴 뒤 자원을 빼앗을 수 있는 상대 */
  stealFrom: string[];
  /** 동상 옮기기·공짜 길이 끝나면 돌아갈 단계 (기사 카드를 굴리기 전에 쓰면 roll 로 돌아간다) */
  resumeStep: TurnStep;
  /** 이 게임의 보드 칸 (맵 모양과 땅 배치). 꼭짓점·변은 boardOf 로 이 값에서 계산한다. */
  tiles: TileDef[];
  /** 배를 띄울 바다 칸 (섬 맵). 배를 안 쓰는 맵이면 빈 목록이다. */
  sea: SeaCell[];
  /** 기사단 동상이 서 있는 칸. 이 칸은 숫자가 나와도 생산하지 않는다. */
  robber: TileId;
  /** 칸마다 놓인 숫자 토큰 (광장은 없음) */
  numbers: Record<TileId, number>;
  harbors: Harbor[];
  players: Record<string, PlayerGameState>;
  buildings: Building[];
  roads: Road[];
  /** 바다 위의 배 (섬 맵) */
  ships: Ship[];
  /** 이번 턴에 배를 이미 옮겼는지 (한 턴에 한 척, 한 번) */
  shipMoved: boolean;
  /** 해적선이 선 바다 칸 (섬 맵, 없으면 null). 그 칸의 여섯 변에는 배를 띄우거나 옮기지 못한다. */
  pirate: SeaCellId | null;
  /** 새 섬 보너스를 받은 작은 섬 번호 (사람마다). 섬마다 ISLAND_BONUS_POINTS 점이다. */
  islandBonus: Record<string, number[]>;
  /** 금광에서 원하는 자원을 골라 받을 장수 (사람마다). 주사위로 생겼으면 다 고를 때까지 gold 단계다. */
  goldPicks: Record<string, number>;
  /** 남은 발전 카드 (맨 뒤부터 뽑는다). 제한 없음이면 줄지 않고 이 구성에서 무작위로 뽑는다. */
  devDeck: DevKind[];
  /** 개수 제한 없음: 길·마을·도시를 몇 개든 짓고 발전 카드도 떨어지지 않는다 (방장이 고른 규칙) */
  unlimited: boolean;
  /** 한 사람이 가질 수 있는 길·마을·도시 개수 (방장이 정한 값) */
  pieceLimits: PieceLimits;
  /** 주사위 방식: random 은 그냥 굴리기, balanced 는 고르게 굴리기 (fairDice.ts) */
  diceMode: DiceMode;
  /** 7 버리기: 7이 나오면 보유 한도보다 많이 든 사람이 절반을 버린다 (방장이 끌 수 있다. 꺼도 동상 옮기기·빼앗기는 그대로) */
  sevenDiscard: boolean;
  /** 최장 교역로 2점이 있는지 (방장이 끌 수 있다. 끄면 아무도 갖지 않는다) */
  longestRoadAward: boolean;
  /** 최강 기사단 2점이 있는지 (방장이 끌 수 있다. 꺼도 기사 카드는 그대로 쓴다) */
  largestArmyAward: boolean;
  /** 고르게 굴리기의 남은 눈 카드와 기록 (random 이면 null). 화면에는 보내지 않는다. */
  fairDice: FairDiceState | null;
  /** 이번 턴에 발전 카드를 이미 썼는지 (승점 카드 제외, 한 턴에 1장) */
  devPlayedThisTurn: boolean;
  /** 길 건설 카드로 남은 공짜 길 (섬 맵에서는 배로 띄워도 된다) */
  freeRoads: number;
  longestRoad: { holder: string | null; length: number };
  largestArmy: { holder: string | null; size: number };
  /** 이 승점에 먼저 닿으면 이긴다 (방장이 정한 값, 10~20) */
  winPoints: number;
  /** 열린 교환 제안 (차례인 사람이 낸 것, 최대 MAX_OPEN_TRADES 개, 낸 순서대로) */
  trades: TradeOffer[];
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
  | 'WRONG_STEP'
  | 'NOT_YOUR_TURN'
  | 'NOT_ENOUGH'
  | 'SPOT_INVALID'
  | 'SPOT_TAKEN'
  | 'TOO_CLOSE'
  | 'NOT_CONNECTED'
  | 'LIMIT'
  | 'NO_CARD'
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

export interface GameOptions {
  /** 승리 점수 (기본 10) */
  winPoints?: number;
  /** 자원 보유 한도 (기본 7) */
  handLimit?: number;
  /**
   * true 면 모두 주사위를 굴려 자리 순서를 정하는 단계(order)부터 시작한다. 높은 사람이 먼저, 가장 낮은 사람이 마지막.
   * false 면 서버가 섞은 순서로 바로 시작 배치를 한다 (규칙 테스트용).
   */
  rollForOrder?: boolean;
  /** 맵 모양과 땅 배치 (기본: 육각형 황금 배치) */
  map?: MapConfig;
  /** 은행에 두는 자원 카드 수, 자원마다 (기본 19) */
  resourceCards?: number;
  /** 발전 카드 더미의 총 장수 (기본 25, 종류 비율은 그대로) */
  devCards?: number;
  /** 발전 카드 종류별 장수. 주면 devCards 대신 이 구성으로 더미를 만든다 (방장이 종류마다 정했을 때) */
  devMix?: DevMix;
  /** 한 사람이 가질 수 있는 길·마을·도시 개수 (기본 15·5·4) */
  pieceLimits?: PieceLimits;
  /** 개수 제한 없음: 길·마을·도시 개수 제한과 발전 카드 소진이 없다 (기본 false) */
  unlimited?: boolean;
  /** 주사위 방식 (기본 random: 규칙 테스트가 난수로 눈을 정한다. 방은 balanced 가 기본) */
  diceMode?: DiceMode;
  /** 7 버리기 (기본 true) */
  sevenDiscard?: boolean;
  /** 최장 교역로 달성 (기본 true) */
  longestRoadAward?: boolean;
  /** 최강 기사단 달성 (기본 true) */
  largestArmyAward?: boolean;
}

/** 한 사람이 가질 수 있는 조각 수 (방장이 정한 개수, 없으면 기본값). 개수 제한 없음이면 끝이 없다. */
export function pieceLimit(s: { unlimited?: boolean; pieceLimits?: PieceLimits }, kind: PieceKind): number {
  return s.unlimited ? Infinity : (s.pieceLimits?.[kind] ?? PIECE_LIMIT[kind]);
}

export function createGame(playerIds: string[], random: () => number = Math.random, opts: number | GameOptions = {}): GameState {
  const o: GameOptions = typeof opts === 'number' ? { winPoints: opts } : opts;
  const winPoints = o.winPoints ?? WIN_POINTS;
  const handLimit = o.handLimit ?? DISCARD_LIMIT;
  if (normalizeWinPoints(winPoints) === null) throw new Error(`승리 점수는 ${WIN_POINTS_MIN}~${WIN_POINTS_MAX}점이어야 합니다.`);
  if (normalizeHandLimit(handLimit) === null) throw new Error(`자원 보유 한도는 ${HAND_LIMIT_MIN}~${HAND_LIMIT_MAX}장이어야 합니다.`);
  const mapConfig = o.map ?? DEFAULT_MAP;
  const cardDefaults = mapCardDefaults(mapConfig.shape);
  const resourceCards = o.resourceCards ?? cardDefaults.resourceCards;
  const devCards = o.devCards ?? cardDefaults.devCards;
  if (normalizeResourceCards(resourceCards) === null) throw new Error(`자원 카드는 종류마다 ${RESOURCE_CARDS_MIN}~${RESOURCE_CARDS_MAX}장이어야 합니다.`);
  if (!o.devMix && normalizeDevCards(devCards) === null) throw new Error(`발전 카드는 ${DEV_CARDS_MIN}~${DEV_CARDS_MAX}장이어야 합니다.`);
  const devMix = o.devMix ? normalizeDevMix(o.devMix) : null;
  if (o.devMix && !devMix) throw new Error(`발전 카드는 종류마다 0~${DEV_KIND_MAX}장, 모두 합쳐 1~${DEV_CARDS_MAX}장이어야 합니다.`);
  const pieceLimits = o.pieceLimits ? normalizePieceLimits(o.pieceLimits) : { ...PIECE_LIMIT };
  if (!pieceLimits) throw new Error('길·마을·도시·배 개수가 고를 수 있는 범위를 벗어났습니다.');
  const maxPlayers = maxPlayersFor(mapConfig.shape);
  if (playerIds.length < MIN_PLAYERS || playerIds.length > maxPlayers) {
    throw new Error(`플레이어는 ${MIN_PLAYERS}~${maxPlayers}명이어야 합니다.`);
  }
  if (new Set(playerIds).size !== playerIds.length) throw new Error('플레이어 ID가 중복되었습니다.');
  const order = o.rollForOrder ? [...playerIds] : shuffle(playerIds, random);
  const players: Record<string, PlayerGameState> = {};
  for (const id of order) players[id] = { id, resources: emptyBundle(), devCards: [], knightsPlayed: 0 };
  const counts = devMix ?? devDeckFor(devCards);
  const deck = (Object.keys(counts) as DevKind[]).flatMap((k) => Array<DevKind>(counts[k]).fill(k));
  const map = buildMap(mapConfig, random);
  const state: GameState = {
    phase: o.rollForOrder ? 'order' : 'placement',
    order,
    startRolls: Object.fromEntries(order.map((id) => [id, []])),
    startPending: o.rollForOrder ? [...order] : [],
    placementIndex: 0,
    setupVillage: null,
    handLimit,
    bank: Object.fromEntries(RESOURCES.map((r) => [r, resourceCards])) as Bundle,
    bankSize: resourceCards,
    turn: 0,
    current: 0,
    step: 'roll',
    dice: null,
    discards: {},
    stealFrom: [],
    resumeStep: 'main',
    tiles: map.tiles,
    sea: map.sea,
    robber: map.robber,
    numbers: map.numbers,
    harbors: map.harbors,
    players,
    buildings: [],
    roads: [],
    ships: [],
    shipMoved: false,
    pirate: map.pirate,
    islandBonus: {},
    goldPicks: {},
    devDeck: shuffle(deck, random),
    unlimited: !!o.unlimited,
    pieceLimits,
    diceMode: o.diceMode ?? 'random',
    sevenDiscard: o.sevenDiscard !== false,
    longestRoadAward: o.longestRoadAward !== false,
    largestArmyAward: o.largestArmyAward !== false,
    fairDice: o.diceMode === 'balanced' ? newFairDice(order) : null,
    devPlayedThisTurn: false,
    freeRoads: 0,
    longestRoad: { holder: null, length: 0 },
    largestArmy: { holder: null, size: 0 },
    winPoints,
    trades: [],
    tradeSeq: 0,
    events: [],
    eventSeq: 0,
    result: null,
    version: 1,
  };
  if (!o.rollForOrder) pushEvent(state, { kind: 'game_start', order: [...order] });
  return state;
}

function pushEvent(s: GameState, e: NewGameEvent): void {
  s.eventSeq += 1;
  s.events.push({ ...e, seq: s.eventSeq, turn: s.turn } as GameEvent);
}

// ───────────────────────── 조회 함수 ─────────────────────────

/** 시작 배치 순서: 자리 순서대로 한 바퀴, 다시 거꾸로 한 바퀴 (마지막 자리는 두 번 연달아 놓는다) */
export function placementOrder(s: Pick<GameState, 'order'>): string[] {
  return [...s.order, ...[...s.order].reverse()];
}

export function placementPlayer(s: GameState): string | null {
  if (s.phase !== 'placement') return null;
  return placementOrder(s)[s.placementIndex] ?? null;
}

export function currentPlayer(s: GameState): string | null {
  if (s.phase !== 'playing') return null;
  return s.order[s.current] ?? null;
}

export function buildingAt(buildings: readonly Building[], vertexId: VertexId): Building | null {
  return buildings.find((b) => b.vertexId === vertexId) ?? null;
}

export function roadAt(roads: readonly Road[], edgeId: EdgeId): Road | null {
  return roads.find((r) => r.edgeId === edgeId) ?? null;
}

export function buildingsOf(buildings: readonly Building[], playerId: string): Building[] {
  return buildings.filter((b) => b.owner === playerId);
}

export function roadsOf(roads: readonly Road[], playerId: string): Road[] {
  return roads.filter((r) => r.owner === playerId);
}

export function shipAt(ships: readonly Ship[], edgeId: EdgeId): Ship | null {
  return ships.find((s) => s.edgeId === edgeId) ?? null;
}

/** 한 사람이 가진 조각 수 (길, 마을, 도시, 배) */
export function pieceCount(buildings: readonly Building[], roads: readonly Road[], playerId: string, kind: PieceKind, ships: readonly Ship[] = []): number {
  if (kind === 'road') return roadsOf(roads, playerId).length;
  if (kind === 'ship') return ships.filter((s) => s.owner === playerId).length;
  return buildings.filter((b) => b.owner === playerId && b.kind === kind).length;
}

/** 마을 1점, 도시 2점 */
export function buildingPoints(buildings: readonly Building[], playerId: string): number {
  return buildingsOf(buildings, playerId).reduce((n, b) => n + PIECE_POINTS[b.kind], 0);
}

/** 거리 규칙: 비어 있고, 변 하나로 이어진 이웃 꼭짓점에도 마을·도시가 없어야 한다. */
export function vertexOpen(board: BoardGeometry, buildings: readonly Building[], vertexId: VertexId): boolean {
  const v = board.vertexMap[vertexId];
  if (!v || buildingAt(buildings, vertexId)) return false;
  return v.neighbors.every((n) => !buildingAt(buildings, n));
}

/**
 * 시작 배치로 마을을 놓을 수 있는 꼭짓점: 거리 규칙을 지킨 빈 꼭짓점.
 * 섬 맵은 큰 섬에서만 시작한다 (작은 섬은 배로 건너가 개척하는 곳이다).
 */
export function placeableVertices(board: BoardGeometry, buildings: readonly Building[]): VertexId[] {
  const islands = 'islandOf' in board && (board as Board).sea ? (board as Board) : null;
  return board.vertices
    .filter((v) => vertexOpen(board, buildings, v.id) && (!islands || smallIslandAt(islands, v.id) === null))
    .map((v) => v.id);
}

/** 시작 배치에서 방금 고른 꼭짓점에 붙여 놓을 수 있는 길 */
export function setupRoadEdges(board: BoardGeometry, roads: readonly Road[], vertexId: VertexId): EdgeId[] {
  return (board.vertexMap[vertexId]?.edges ?? []).filter((e) => !roadAt(roads, e));
}

/** 시작 배치에서 방금 고른 바닷가 꼭짓점에 길 대신 붙여 띄울 수 있는 배 (섬 맵, 해적선이 막은 바닷길은 빼고) */
export function setupShipEdges(board: ShipBoard, roads: readonly Road[], ships: readonly Ship[], vertexId: VertexId, pirate: SeaCellId | null = null): EdgeId[] {
  const net = board.sea;
  if (!net) return [];
  const blocked = pirateEdges(net, pirate);
  return (net.vertexMap[vertexId]?.edges ?? []).filter((e) => !roadAt(roads, e) && !shipAt(ships, e) && !blocked.has(e));
}

function touchesOwnRoad(board: BoardGeometry, roads: readonly Road[], vertexId: VertexId, playerId: string): boolean {
  return (board.vertexMap[vertexId]?.edges ?? []).some((e) => roadAt(roads, e)?.owner === playerId);
}

function touchesOwnShip(board: ShipBoard, ships: readonly Ship[], vertexId: VertexId, playerId: string): boolean {
  return (board.sea?.vertexMap[vertexId]?.edges ?? []).some((e) => shipAt(ships, e)?.owner === playerId);
}

/**
 * 길을 놓을 수 있는 변: 비어 있고(길도 배도 없고), 한쪽 끝이 내 마을·도시이거나 내 길과 이어진다.
 * 남의 마을이 선 꼭짓점을 지나서는 잇지 못하고, 배에서 길로는 내 마을·도시를 거쳐야만 이어진다.
 */
export function buildableRoads(board: BoardGeometry, buildings: readonly Building[], roads: readonly Road[], playerId: string, ships: readonly Ship[] = []): EdgeId[] {
  return board.edges.filter((e) => {
    if (roadAt(roads, e.id) || shipAt(ships, e.id)) return false;
    return [e.a, e.b].some((v) => {
      const b = buildingAt(buildings, v);
      if (b) return b.owner === playerId;
      return (board.vertexMap[v].edges ?? []).some((other) => other !== e.id && roadAt(roads, other)?.owner === playerId);
    });
  }).map((e) => e.id);
}

/** 마을을 지을 수 있는 꼭짓점: 거리 규칙을 지키고 내 길이나 내 배가 닿아 있어야 한다. */
export function buildableVillages(board: ShipBoard, buildings: readonly Building[], roads: readonly Road[], playerId: string, ships: readonly Ship[] = []): VertexId[] {
  return board.vertices
    .filter((v) => vertexOpen(board, buildings, v.id) && (touchesOwnRoad(board, roads, v.id, playerId) || touchesOwnShip(board, ships, v.id, playerId)))
    .map((v) => v.id);
}

// ───────────────────────── 배 ─────────────────────────

/** 꼭짓점 v 에서 배가 이어지는지: 내 마을·도시가 섰거나, 빈 꼭짓점에 (except 말고) 내 배가 닿아 있다. */
function shipJoins(net: SeaNet, buildings: readonly Building[], ships: readonly Ship[], v: VertexId, playerId: string, except: EdgeId): boolean {
  const b = buildingAt(buildings, v);
  if (b) return b.owner === playerId;
  return (net.vertexMap[v]?.edges ?? []).some((o) => o !== except && shipAt(ships, o)?.owner === playerId);
}

/** 해적선이 선 바다 칸의 여섯 변 (해적선이 없으면 빈 묶음) */
export function pirateEdges(net: SeaNet | null | undefined, pirate: SeaCellId | null | undefined): ReadonlySet<EdgeId> {
  return new Set(net && pirate ? (net.cellEdges[pirate] ?? []) : []);
}

/**
 * 배를 띄울 수 있는 변: 바다에 닿은 빈 변(길도 배도 없는)이고, 한쪽 끝이 내 마을·도시이거나 내 배와 이어진다.
 * 길에서 배로는 내 마을·도시를 거쳐야 이어지고, 남의 마을·도시가 선 꼭짓점을 지나서는 잇지 못한다.
 * 해적선이 선 바다 칸의 변에는 띄우지 못한다.
 */
export function buildableShips(
  board: ShipBoard,
  buildings: readonly Building[],
  roads: readonly Road[],
  ships: readonly Ship[],
  playerId: string,
  pirate: SeaCellId | null = null,
): EdgeId[] {
  const net = board.sea;
  if (!net) return [];
  const blocked = pirateEdges(net, pirate);
  return net.edges
    .filter((e) => !blocked.has(e.id) && !shipAt(ships, e.id) && !roadAt(roads, e.id) && [e.a, e.b].some((v) => shipJoins(net, buildings, ships, v, playerId, e.id)))
    .map((e) => e.id);
}

/**
 * 배가 항로의 열린 끝에 있는지: 한쪽 끝에 내 마을·도시도, 이어지는 내 다른 배도 없다.
 * 양 끝이 모두 내 마을·도시나 내 배로 이어진 배(닫힌 항로나 항로 가운데)는 옮기지 못한다. 남의 마을·도시가 선 끝은 열린 끝으로 본다.
 */
function shipLoose(net: SeaNet, buildings: readonly Building[], ships: readonly Ship[], ship: Ship): boolean {
  const e = net.edgeMap[ship.edgeId];
  if (!e) return false;
  return [e.a, e.b].some((v) => !shipJoins(net, buildings, ships, v, ship.owner, e.id));
}

type ShipState = Pick<GameState, 'tiles' | 'sea' | 'buildings' | 'roads' | 'ships' | 'turn' | 'shipMoved' | 'pirate'>;

/** 배를 옮길 수 없는 까닭 (옮길 수 있으면 null). 차례·단계는 따로 본다. */
export function shipMoveProblem(s: ShipState, playerId: string, from: EdgeId): string | null {
  const net = boardOf(s).sea;
  const ship = shipAt(s.ships, from);
  if (!net || !ship || ship.owner !== playerId) return '옮길 내 배를 고르세요.';
  if (s.shipMoved) return '배는 한 턴에 한 번만 옮길 수 있습니다.';
  if (ship.builtTurn >= s.turn) return '이번 턴에 띄운 배는 다음 턴부터 옮길 수 있습니다.';
  if (pirateEdges(net, s.pirate).has(from)) return '해적선 옆에 묶인 배는 해적선이 떠날 때까지 옮길 수 없습니다.';
  if (!shipLoose(net, s.buildings, s.ships, ship)) return '항로 끝에 있는 배만 옮길 수 있습니다. 양 끝이 내 마을·도시나 다른 배와 이어진 배는 그대로 둡니다.';
  if (!shipMoveTargets(s, playerId, from).length) return '이 배를 옮겨 댈 곳이 없습니다.';
  return null;
}

/** 지금 옮길 수 있는 내 배 (항로 끝에 있고, 이번 턴에 띄우지 않았고, 이번 턴에 아직 배를 옮기지 않았다) */
export function movableShips(s: ShipState, playerId: string): EdgeId[] {
  return s.ships.filter((sh) => sh.owner === playerId && !shipMoveProblem(s, playerId, sh.edgeId)).map((sh) => sh.edgeId);
}

/** 배 from 을 옮겨 댈 수 있는 변: 그 배를 빼고 보았을 때 배를 띄울 수 있는 다른 변 (해적선 옆은 빼고) */
export function shipMoveTargets(s: ShipState, playerId: string, from: EdgeId): EdgeId[] {
  const rest = s.ships.filter((sh) => sh.edgeId !== from);
  return buildableShips(boardOf(s), s.buildings, s.roads, rest, playerId, s.pirate).filter((id) => id !== from);
}

// ───────────────────────── 새 섬·해적선·금광 (섬 맵) ─────────────────────────

/** 새 섬 보너스로 받은 점수 */
export function islandBonusPoints(s: Pick<GameState, 'islandBonus'>, playerId: string): number {
  return (s.islandBonus?.[playerId]?.length ?? 0) * ISLAND_BONUS_POINTS;
}

/** 해적선을 옮긴 바다 칸에 배가 닿은 상대 중 자원이 있는 사람 (배가 여러 척이어도 한 번만) */
export function pirateStealCandidates(s: GameState, cell: SeaCellId, playerId: string): string[] {
  const edges = pirateEdges(boardOf(s).sea, cell);
  const owners = new Set(s.ships.filter((sh) => sh.owner !== playerId && edges.has(sh.edgeId)).map((sh) => sh.owner));
  return s.order.filter((id) => owners.has(id) && bundleTotal(s.players[id].resources) > 0);
}

/** 해적선을 옮길 수 있는 바다 칸 (지금 선 칸 말고 모두). 섬 맵이 아니면 빈 목록. */
export function pirateTargets(s: Pick<GameState, 'tiles' | 'sea' | 'pirate'>): SeaCellId[] {
  const net = boardOf(s).sea;
  return net ? Object.keys(net.cellMap).filter((c) => c !== s.pirate) : [];
}

/** 도시로 올릴 수 있는 꼭짓점: 내 마을 (도시는 마을을 올려서만 짓는다) */
export function upgradableVillages(buildings: readonly Building[], playerId: string): VertexId[] {
  return buildings.filter((b) => b.owner === playerId && b.kind === 'village').map((b) => b.vertexId);
}

/** 이 사람이 쓸 수 있는 은행 교환 비율 (기본 4, 아무 자원 교역로 3, 그 자원 교역로 2) */
export function tradeRatios(s: Pick<GameState, 'harbors' | 'buildings' | 'tiles'>, playerId: string): Record<Resource, number> {
  const board = boardOf(s);
  const ratio = Object.fromEntries(RESOURCES.map((r) => [r, BANK_RATIO])) as Record<Resource, number>;
  for (const h of s.harbors) {
    const [a, b] = harborVertices(board, h);
    const mine = [a, b].some((v) => buildingAt(s.buildings, v)?.owner === playerId);
    if (!mine) continue;
    if (h.resource) ratio[h.resource] = Math.min(ratio[h.resource], SPECIAL_HARBOR_RATIO);
    else for (const r of RESOURCES) ratio[r] = Math.min(ratio[r], GENERIC_HARBOR_RATIO);
  }
  return ratio;
}

/**
 * 주사위 합이 total 일 때의 생산. 마을은 1개, 도시는 2개. 기사단 동상이 선 칸은 생산하지 않는다.
 * 금광(섬 맵)은 자원 대신 골라 받을 장수(gold)를 준다.
 */
export function productionFor(
  s: Pick<GameState, 'numbers' | 'robber' | 'buildings' | 'tiles'>,
  total: number,
  playerIds: readonly string[],
): { gains: Record<string, Bundle>; gold: Record<string, number>; tiles: TileId[]; blocked: TileId[] } {
  const gains: Record<string, Bundle> = {};
  const gold: Record<string, number> = {};
  for (const id of playerIds) gains[id] = emptyBundle();
  const board = boardOf(s);
  const hit = board.tiles.filter((t) => t.kind !== 'plaza' && s.numbers[t.id] === total);
  const tiles = hit.filter((t) => t.id !== s.robber).map((t) => t.id);
  const blocked = hit.filter((t) => t.id === s.robber).map((t) => t.id);
  for (const b of s.buildings) {
    if (!gains[b.owner]) continue;
    for (const tileId of board.vertexMap[b.vertexId]?.tiles ?? []) {
      if (!tiles.includes(tileId)) continue;
      const kind = board.tileMap[tileId].kind;
      const n = b.kind === 'city' ? 2 : 1;
      if (kind === 'gold') gold[b.owner] = (gold[b.owner] ?? 0) + n;
      else if (kind !== 'plaza') gains[b.owner][kind] += n;
    }
  }
  return { gains, gold, tiles, blocked };
}

/**
 * 한 사람의 가장 긴 교역로 (이어진 길과 배의 변 수). 같은 변을 두 번 지나지 않고, 남의 마을·도시가 선 꼭짓점에서는 끊긴다.
 * 길과 배는 내 마을·도시가 선 꼭짓점에서만 서로 이어진다 (길 끝에서 바로 배로 넘어가지 않는다).
 * 한 사람의 길·배는 각각 최대 15개라 모든 출발점에서 깊이 우선으로 찾아도 충분히 빠르다.
 */
export function longestRoadLength(board: ShipBoard, roads: readonly Road[], buildings: readonly Building[], playerId: string, ships: readonly Ship[] = []): number {
  return longestRoadPath(board, roads, buildings, playerId, ships).length;
}

/** 한 사람의 가장 긴 교역로를 이루는 변들 (순서대로). 길이가 같은 것이 여럿이면 먼저 찾은 것. */
export function longestRoadPath(board: ShipBoard, roads: readonly Road[], buildings: readonly Building[], playerId: string, ships: readonly Ship[] = []): EdgeId[] {
  type Seg = { id: EdgeId; a: VertexId; b: VertexId; ship: boolean };
  const mine: Seg[] = [];
  for (const r of roads) {
    const e = r.owner === playerId ? board.edgeMap[r.edgeId] : undefined;
    if (e) mine.push({ id: e.id, a: e.a, b: e.b, ship: false });
  }
  for (const sh of ships) {
    const e = sh.owner === playerId ? board.sea?.edgeMap[sh.edgeId] : undefined;
    if (e) mine.push({ id: e.id, a: e.a, b: e.b, ship: true });
  }
  if (!mine.length) return [];
  const adj = new Map<VertexId, Seg[]>();
  for (const e of mine) for (const v of [e.a, e.b]) adj.set(v, [...(adj.get(v) ?? []), e]);
  const owner = (v: VertexId) => buildingAt(buildings, v)?.owner ?? null;
  let best: EdgeId[] = [];
  const used = new Set<EdgeId>();
  const stack: EdgeId[] = [];
  const walk = (v: VertexId, last: Seg | null) => {
    if (stack.length > best.length) best = [...stack];
    const at = owner(v);
    if (last && at !== null && at !== playerId) return;
    for (const e of adj.get(v) ?? []) {
      if (used.has(e.id)) continue;
      if (last && last.ship !== e.ship && at !== playerId) continue;
      used.add(e.id);
      stack.push(e.id);
      walk(e.a === v ? e.b : e.a, e);
      stack.pop();
      used.delete(e.id);
    }
  };
  for (const v of adj.keys()) walk(v, null);
  return best;
}

/** 승점: 마을·도시 + 새 섬 보너스 + 최장 교역로·최강 기사단 각 2점(방장이 끄지 않았을 때) (+ 숨긴 승점 카드, hidden=true 일 때) */
export function victoryPoints(s: GameState, playerId: string, includeHidden = false): number {
  let vp = buildingPoints(s.buildings, playerId) + islandBonusPoints(s, playerId);
  if (s.longestRoadAward !== false && s.longestRoad.holder === playerId) vp += AWARD_POINTS;
  if (s.largestArmyAward !== false && s.largestArmy.holder === playerId) vp += AWARD_POINTS;
  if (includeHidden) vp += s.players[playerId].devCards.filter((c) => c.kind === 'victory').length;
  return vp;
}

/** 이번 턴에 쓸 수 있는 발전 카드인지 (산 턴에 산 카드·승점 카드는 쓰지 않는다) */
export function playableDev(s: GameState, playerId: string, kind: DevKind): boolean {
  if (kind === 'victory') return false;
  return s.players[playerId].devCards.some((c) => c.kind === kind && c.boughtTurn < s.turn);
}

/** 기사단 동상을 옮긴 칸에 마을·도시가 닿은 상대 중 자원이 있는 사람 */
export function stealCandidates(s: GameState, tileId: TileId, playerId: string): string[] {
  const owners = new Set<string>();
  for (const b of s.buildings) {
    if (b.owner === playerId) continue;
    if (!boardOf(s).vertexMap[b.vertexId]?.tiles.includes(tileId)) continue;
    if (bundleTotal(s.players[b.owner].resources) > 0) owners.add(b.owner);
  }
  return s.order.filter((id) => owners.has(id));
}

// ───────────────────────── 행동 처리 ─────────────────────────

export function applyAction(s: GameState, playerId: string, action: GameAction, random: () => number = Math.random): ActionResult {
  if (!s.players[playerId]) return fail('NOT_ALLOWED', '이 게임의 참가자가 아닙니다.');
  if (s.phase === 'finished') return fail('WRONG_PHASE', '게임이 이미 끝났습니다.');
  const eventsBefore = s.eventSeq;
  let result: ActionResult;
  switch (action.type) {
    case 'order_roll':
      result = doOrderRoll(s, playerId, random);
      break;
    case 'place_village':
      result = doPlaceVillage(s, playerId, action.vertexId);
      break;
    case 'place_road':
      result = doPlaceRoad(s, playerId, action.edgeId);
      break;
    case 'place_ship':
      result = doPlaceShip(s, playerId, action.edgeId);
      break;
    case 'place':
      result = doPlace(s, playerId, action.vertexId, action.edgeId);
      break;
    case 'roll':
      result = doRoll(s, playerId, random);
      break;
    case 'discard':
      result = doDiscard(s, playerId, action.bundle);
      break;
    case 'move_robber':
      result = doMoveRobber(s, playerId, action.tileId, random);
      break;
    case 'move_pirate':
      result = doMovePirate(s, playerId, action.cell, random);
      break;
    case 'gold_pick':
      result = doGoldPick(s, playerId, action.bundle);
      break;
    case 'steal':
      result = doSteal(s, playerId, action.from, random);
      break;
    case 'build_road':
      result = doBuildRoad(s, playerId, action.edgeId);
      break;
    case 'build_ship':
      result = doBuildShip(s, playerId, action.edgeId);
      break;
    case 'move_ship':
      result = doMoveShip(s, playerId, action.from, action.to);
      break;
    case 'build_village':
      result = doBuildVillage(s, playerId, action.vertexId);
      break;
    case 'build_city':
      result = doBuildCity(s, playerId, action.vertexId);
      break;
    case 'buy_dev':
      result = doBuyDev(s, playerId, random);
      break;
    case 'play_dev':
      result = doPlayDev(s, playerId, action);
      break;
    case 'bank_trade':
      result = doBankTrade(s, playerId, action.give, action.get);
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
    case 'trade_confirm':
      result = doTradeConfirm(s, playerId, action.tradeId, action.with);
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
  if (s.eventSeq !== eventsBefore) s.version += 1;
  return result;
}

/** 순서 정하기 주사위 합 비교: 처음 굴린 값부터 차례로 견주어 큰 쪽이 앞선다. 같은 수로 다시 굴린 사람끼리만 길이가 같다. */
function compareStartRolls(a: [number, number][], b: [number, number][]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ? a[i][0] + a[i][1] : 0;
    const y = b[i] ? b[i][0] + b[i][1] : 0;
    if (x !== y) return y - x;
  }
  return 0;
}

/**
 * 순서 정하기: 아직 굴리지 않은 사람은 아무 때나(동시에) 주사위를 굴린다. 다 굴리면 높은 사람부터 자리를 매기고,
 * 같은 수가 나온 사람들만 다시 굴려 그 사이 순서를 정한다. 가장 낮은 사람이 마지막이다.
 */
function doOrderRoll(s: GameState, playerId: string, random: () => number): ActionResult {
  if (s.phase !== 'order') return fail('WRONG_PHASE', '순서를 정하는 단계가 아닙니다.');
  if (!s.startPending.includes(playerId)) return fail('NOT_ALLOWED', '이미 주사위를 굴렸습니다. 다른 사람을 기다리세요.');
  const dice: [number, number] = [1 + Math.floor(random() * 6), 1 + Math.floor(random() * 6)];
  s.startRolls[playerId].push(dice);
  s.startPending = s.startPending.filter((id) => id !== playerId);
  pushEvent(s, { kind: 'order_roll', player: playerId, dice, round: s.startRolls[playerId].length });
  if (s.startPending.length) return OK;

  // 모두 굴렸다: 기록이 똑같은 사람끼리 묶어 둘 이상이면 그 사람들만 다시 굴린다.
  const groups = new Map<string, string[]>();
  for (const id of s.order) {
    const key = s.startRolls[id].map((d) => d[0] + d[1]).join(',');
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  const tied = [...groups.values()].filter((g) => g.length > 1);
  if (tied.length) {
    for (const g of tied) {
      const last = s.startRolls[g[0]].at(-1)!;
      pushEvent(s, { kind: 'order_tie', players: [...g], total: last[0] + last[1] });
    }
    s.startPending = s.order.filter((id) => tied.some((g) => g.includes(id)));
    return OK;
  }
  s.order = [...s.order].sort((a, b) => compareStartRolls(s.startRolls[a], s.startRolls[b]));
  s.phase = 'placement';
  s.placementIndex = 0;
  pushEvent(s, { kind: 'game_start', order: [...s.order] });
  return OK;
}

function placementCheck(s: GameState, playerId: string): ActionResult | null {
  if (s.phase !== 'placement') return fail('WRONG_PHASE', '시작 배치 단계가 아닙니다.');
  if (placementPlayer(s) !== playerId) return fail('NOT_YOUR_TURN', '지금은 다른 사람이 시작 마을을 놓을 차례입니다.');
  return null;
}

function villageSpotProblem(s: GameState, vertexId: VertexId): ActionResult | null {
  if (!boardOf(s).vertexMap[vertexId]) return fail('SPOT_INVALID', '보드에 없는 꼭짓점입니다.');
  if (buildingAt(s.buildings, vertexId)) return fail('SPOT_TAKEN', '이미 마을이 있는 꼭짓점입니다.');
  if (!vertexOpen(boardOf(s), s.buildings, vertexId)) return fail('TOO_CLOSE', '바로 옆 꼭짓점에 마을이 있어 지을 수 없습니다. 한 칸 이상 떨어뜨리세요.');
  if (smallIslandAt(boardOf(s), vertexId) !== null) return fail('SPOT_INVALID', '작은 섬에는 시작 마을을 지을 수 없습니다. 큰 섬에서 시작해 배로 건너가세요.');
  return null;
}

function roadSpotProblem(s: GameState, vertexId: VertexId, edgeId: EdgeId): ActionResult | null {
  const edge = boardOf(s).edgeMap[edgeId];
  if (!edge || (edge.a !== vertexId && edge.b !== vertexId)) return fail('NOT_CONNECTED', '시작 길은 방금 지은 마을에 붙여 놓아야 합니다.');
  if (roadAt(s.roads, edgeId)) return fail('SPOT_TAKEN', '이미 길이 있는 변입니다.');
  return null;
}

/**
 * 시작 마을을 짓는다. 두 번째 시작 마을은 닿은 생산 칸마다 자원 1장을 바로 받는다 (금광이면 원하는 자원 1장을 골라 받을 몫이 생긴다).
 * 길은 place_road (섬 맵의 바닷가면 배는 place_ship) 로 이어 놓는다.
 */
function putSetupVillage(s: GameState, playerId: string, vertexId: VertexId): Bundle | undefined {
  s.buildings.push({ vertexId, owner: playerId, kind: 'village', builtTurn: 0 });
  s.setupVillage = vertexId;
  if (s.placementIndex < s.order.length) return undefined;
  const gained = emptyBundle();
  for (const t of boardOf(s).vertexMap[vertexId].tiles) {
    const kind = boardOf(s).tileMap[t].kind;
    if (kind === 'gold') s.goldPicks[playerId] = (s.goldPicks[playerId] ?? 0) + 1;
    else if (kind !== 'plaza' && (!s.bank || s.bank[kind] > gained[kind])) gained[kind] += 1;
  }
  takeFromBank(s, s.players[playerId].resources, gained);
  return gained;
}

/**
 * 시작 길(또는 배)을 놓고 다음 사람에게 넘긴다. 마지막 배치였으면 게임을 시작한다.
 * 시작 마을로 금광 몫을 받아 놓고 아직 고르지 않은 사람이 있으면 첫 주사위 전에 고르는 단계(gold)부터 한다.
 */
function putSetupRoad(s: GameState, playerId: string, edgeId: EdgeId, ship = false): void {
  if (ship) s.ships.push({ edgeId, owner: playerId, builtTurn: 0 });
  else s.roads.push({ edgeId, owner: playerId, builtTurn: 0 });
  s.setupVillage = null;
  s.placementIndex += 1;
  updateLongestRoad(s);
  if (s.placementIndex >= placementOrder(s).length) {
    s.phase = 'playing';
    s.turn = 1;
    s.current = 0;
    s.step = 'roll';
    if (Object.keys(s.goldPicks).length) {
      s.resumeStep = 'roll';
      s.step = 'gold';
    }
  }
}

/** 시작 배치 (섬 맵): 방금 지은 바닷가 시작 마을에 길 대신 배를 붙여 띄운다. */
function doPlaceShip(s: GameState, playerId: string, edgeId: EdgeId): ActionResult {
  const bad = placementCheck(s, playerId);
  if (bad) return bad;
  const vertexId = s.setupVillage;
  if (!vertexId) return fail('WRONG_STEP', '시작 마을을 먼저 지으세요.');
  const net = boardOf(s).sea;
  if (!net) return fail('NOT_ALLOWED', '이 맵에서는 배를 띄울 수 없습니다.');
  const edge = net.edgeMap[edgeId];
  if (!edge || (edge.a !== vertexId && edge.b !== vertexId)) return fail('NOT_CONNECTED', '시작 배는 방금 지은 바닷가 마을에 붙여 띄워야 합니다.');
  if (!setupShipEdges(boardOf(s), s.roads, s.ships, vertexId, s.pirate).includes(edgeId)) return fail('SPOT_TAKEN', '배를 띄울 수 없는 바닷길입니다.');
  pushEvent(s, { kind: 'placement', player: playerId, vertexId, edgeId, step: 'road', ship: true });
  putSetupRoad(s, playerId, edgeId, true);
  return OK;
}

function doPlaceVillage(s: GameState, playerId: string, vertexId: VertexId): ActionResult {
  const bad = placementCheck(s, playerId);
  if (bad) return bad;
  if (s.setupVillage) return fail('WRONG_STEP', '방금 지은 마을에 붙여 길을 먼저 놓으세요.');
  const spot = villageSpotProblem(s, vertexId);
  if (spot) return spot;
  const gained = putSetupVillage(s, playerId, vertexId);
  pushEvent(s, { kind: 'placement', player: playerId, vertexId, step: 'village', ...(gained ? { gained } : {}) });
  return OK;
}

function doPlaceRoad(s: GameState, playerId: string, edgeId: EdgeId): ActionResult {
  const bad = placementCheck(s, playerId);
  if (bad) return bad;
  const vertexId = s.setupVillage;
  if (!vertexId) return fail('WRONG_STEP', '시작 마을을 먼저 지으세요.');
  const spot = roadSpotProblem(s, vertexId, edgeId);
  if (spot) return spot;
  // 기록은 턴 번호가 바뀌기 전(배치 0턴)에 남긴다.
  pushEvent(s, { kind: 'placement', player: playerId, vertexId, edgeId, step: 'road' });
  putSetupRoad(s, playerId, edgeId);
  return OK;
}

/** 시작 마을과 길을 한 번에 놓는다 (마을만 지어 둔 상태면 그 마을에 붙일 길만 받는다). */
function doPlace(s: GameState, playerId: string, vertexId: VertexId, edgeId: EdgeId): ActionResult {
  const bad = placementCheck(s, playerId);
  if (bad) return bad;
  if (s.setupVillage) {
    if (s.setupVillage !== vertexId) return fail('WRONG_STEP', '방금 지은 마을에 붙여 길을 먼저 놓으세요.');
    return doPlaceRoad(s, playerId, edgeId);
  }
  const spot = villageSpotProblem(s, vertexId) ?? roadSpotProblem(s, vertexId, edgeId);
  if (spot) return spot;
  const gained = putSetupVillage(s, playerId, vertexId);
  pushEvent(s, { kind: 'placement', player: playerId, vertexId, edgeId, ...(gained ? { gained } : {}) });
  putSetupRoad(s, playerId, edgeId);
  return OK;
}

function requireTurn(s: GameState, playerId: string, steps: TurnStep[]): ActionResult | null {
  if (s.phase !== 'playing') return fail('WRONG_PHASE', '아직 게임이 시작되지 않았습니다.');
  if (currentPlayer(s) !== playerId) return fail('NOT_YOUR_TURN', '내 차례가 아닙니다.');
  if (!steps.includes(s.step)) return fail('WRONG_STEP', stepHint(s.step));
  return null;
}

function stepHint(step: TurnStep): string {
  switch (step) {
    case 'roll':
      return '먼저 주사위를 굴리세요.';
    case 'discard':
      return '7이 나와 자원을 버리는 중입니다. 모두 버릴 때까지 기다리세요.';
    case 'robber':
      return '먼저 기사단 동상을 옮길 칸을 고르세요.';
    case 'steal':
      return '먼저 자원을 빼앗을 사람을 고르세요.';
    case 'road_building':
      return '길 건설 카드의 공짜 길을 먼저 놓으세요.';
    case 'gold':
      return '금광 자원을 고르는 중입니다. 모두 고를 때까지 기다리세요.';
    default:
      return '지금은 할 수 없습니다.';
  }
}

function doRoll(s: GameState, playerId: string, random: () => number): ActionResult {
  const bad = requireTurn(s, playerId, ['roll']);
  if (bad) return bad;
  // 고르게 굴리기: 눈 카드 더미에서 무게를 준 한 장을 뽑는다. 그 합으로 자원을 받을 사람은 지금 보드로 센다.
  const fair = s.diceMode === 'balanced' ? (s.fairDice ??= newFairDice(s.order)) : null;
  const producers = (t: number) => {
    const p = productionFor(s, t, s.order);
    return s.order.filter((id) => bundleTotal(p.gains[id]) > 0 || (p.gold[id] ?? 0) > 0);
  };
  const dice: [number, number] = fair
    ? drawFairDice(fair, playerId, s.order, producers, random)
    : [1 + Math.floor(random() * 6), 1 + Math.floor(random() * 6)];
  s.dice = dice;
  const total = dice[0] + dice[1];
  if (total === 7) {
    if (fair) recordProduction(fair, s.order, () => false);
    s.discards = {};
    for (const id of s.order) {
      const n = bundleTotal(s.players[id].resources);
      if (s.sevenDiscard !== false && n > s.handLimit) s.discards[id] = Math.floor(n / 2);
    }
    pushEvent(s, { kind: 'roll', player: playerId, dice, gains: {}, tiles: [], blocked: [] });
    s.resumeStep = 'main';
    s.step = Object.keys(s.discards).length ? 'discard' : 'robber';
    return OK;
  }
  const owed = productionFor(s, total, s.order);
  const { tiles, blocked, gold } = owed;
  const { paid: gains, short } = settleProduction(s.bank, owed.gains);
  const totals: Record<string, number> = {};
  for (const id of s.order) {
    takeFromBank(s, s.players[id].resources, gains[id]);
    totals[id] = bundleTotal(gains[id]);
  }
  if (fair) recordProduction(fair, s.order, (id) => totals[id] > 0 || (gold[id] ?? 0) > 0);
  const hasGold = Object.keys(gold).length > 0;
  pushEvent(s, {
    kind: 'roll',
    player: playerId,
    dice,
    gains: totals,
    tiles,
    blocked,
    detail: gains,
    ...(short.length ? { short } : {}),
    ...(hasGold ? { gold: { ...gold } } : {}),
  });
  // 금광에 닿은 사람이 있으면 모두 원하는 자원을 고를 때까지 기다린다.
  for (const [id, n] of Object.entries(gold)) s.goldPicks[id] = (s.goldPicks[id] ?? 0) + n;
  s.resumeStep = 'main';
  s.step = hasGold ? 'gold' : 'main';
  return OK;
}

/** 금광에서 지금 골라 받을 수 있는 장수: 받을 몫과 은행에 남은 자원 중 작은 쪽 */
export function goldPickCount(s: Pick<GameState, 'goldPicks' | 'bank'>, playerId: string): number {
  const owed = s.goldPicks?.[playerId] ?? 0;
  return s.bank ? Math.min(owed, bundleTotal(s.bank)) : owed;
}

/**
 * 금광 자원 고르기: 받을 몫만큼(은행에 그보다 적게 남았으면 남은 만큼) 원하는 자원을 골라 은행에서 받는다.
 * gold 단계에서는 모두 고르면 원래 단계로 돌아가고, 시작 배치 중에 생긴 몫은 아무 때나 고른다.
 */
function doGoldPick(s: GameState, playerId: string, bundle: Bundle): ActionResult {
  const owed = s.goldPicks[playerId] ?? 0;
  if (!owed) return fail('NOT_ALLOWED', '금광에서 골라 받을 자원이 없습니다.');
  if (RESOURCES.some((r) => !Number.isInteger(bundle[r]) || bundle[r] < 0)) return fail('BAD_REQUEST', '고른 수량이 올바르지 않습니다.');
  const count = goldPickCount(s, playerId);
  if (bundleTotal(bundle) !== count) return fail('BAD_REQUEST', `금광 자원 ${count}장을 고르세요.`);
  const lack = s.bank ? RESOURCES.find((r) => bundle[r] > s.bank![r]) : undefined;
  if (lack) return fail('NOT_ENOUGH', `은행에 ${RESOURCE_LABEL[lack]}이(가) ${s.bank![lack]}장밖에 없습니다.`);
  takeFromBank(s, s.players[playerId].resources, bundle);
  delete s.goldPicks[playerId];
  pushEvent(s, { kind: 'gold_pick', player: playerId, count, detail: { ...bundle } });
  if (s.phase === 'playing' && s.step === 'gold' && Object.keys(s.goldPicks).length === 0) s.step = s.resumeStep;
  afterAction(s);
  return OK;
}

function doDiscard(s: GameState, playerId: string, bundle: Bundle): ActionResult {
  if (s.phase !== 'playing' || s.step !== 'discard') return fail('WRONG_STEP', '지금은 자원을 버릴 때가 아닙니다.');
  const need = s.discards[playerId];
  if (!need) return fail('NOT_ALLOWED', '버릴 자원이 없습니다.');
  if (RESOURCES.some((r) => !Number.isInteger(bundle[r]) || bundle[r] < 0)) return fail('BAD_REQUEST', '버릴 수량이 올바르지 않습니다.');
  if (bundleTotal(bundle) !== need) return fail('BAD_REQUEST', `자원 ${need}장을 골라 버리세요.`);
  if (!hasBundle(s.players[playerId].resources, bundle)) return fail('NOT_ENOUGH', '가진 것보다 많이 버릴 수 없습니다.');
  payToBank(s, s.players[playerId].resources, bundle);
  delete s.discards[playerId];
  pushEvent(s, { kind: 'discard', player: playerId, count: need, detail: { ...bundle } });
  if (Object.keys(s.discards).length === 0) s.step = 'robber';
  return OK;
}

function doMoveRobber(s: GameState, playerId: string, tileId: TileId, random: () => number): ActionResult {
  const bad = requireTurn(s, playerId, ['robber']);
  if (bad) return bad;
  if (!boardOf(s).tileMap[tileId]) return fail('SPOT_INVALID', '보드에 없는 칸입니다.');
  if (tileId === s.robber) return fail('SPOT_INVALID', '기사단 동상은 다른 칸으로 옮겨야 합니다.');
  s.robber = tileId;
  pushEvent(s, { kind: 'robber', player: playerId, tileId });
  afterThiefMove(s, playerId, stealCandidates(s, tileId, playerId), random);
  return OK;
}

/** 동상이나 해적선을 옮긴 뒤: 빼앗을 상대가 하나면 바로 빼앗고, 여럿이면 고르는 단계로, 없으면 원래 단계로 돌아간다. */
function afterThiefMove(s: GameState, playerId: string, candidates: string[], random: () => number): void {
  if (candidates.length === 1) {
    stealOne(s, playerId, candidates[0], random);
    s.step = s.resumeStep;
  } else if (candidates.length > 1) {
    s.stealFrom = candidates;
    s.step = 'steal';
  } else {
    s.step = s.resumeStep;
  }
}

/**
 * 해적선 옮기기 (섬 맵): 7이나 기사 카드로 기사단 동상 대신 해적선을 다른 바다 칸으로 옮긴다.
 * 그 칸에 배가 닿은 상대 한 명에게서 자원 1장을 빼앗고, 해적선이 선 칸의 여섯 변에는 배를 띄우거나 옮기지 못한다.
 */
function doMovePirate(s: GameState, playerId: string, cell: SeaCellId, random: () => number): ActionResult {
  const bad = requireTurn(s, playerId, ['robber']);
  if (bad) return bad;
  const net = boardOf(s).sea;
  if (!net) return fail('NOT_ALLOWED', '이 맵에는 해적선이 없습니다.');
  if (!net.cellMap[cell]) return fail('SPOT_INVALID', '해적선은 바다 칸에만 옮길 수 있습니다.');
  if (cell === s.pirate) return fail('SPOT_INVALID', '해적선은 다른 바다 칸으로 옮겨야 합니다.');
  s.pirate = cell;
  pushEvent(s, { kind: 'pirate', player: playerId, cell });
  afterThiefMove(s, playerId, pirateStealCandidates(s, cell, playerId), random);
  return OK;
}

function stealOne(s: GameState, thief: string, from: string, random: () => number): void {
  const pool = RESOURCES.flatMap((r) => Array<Resource>(s.players[from].resources[r]).fill(r));
  if (!pool.length) return;
  const r = pool[Math.floor(random() * pool.length)];
  s.players[from].resources[r] -= 1;
  s.players[thief].resources[r] += 1;
  pushEvent(s, { kind: 'steal', player: thief, from, detail: r });
}

function doSteal(s: GameState, playerId: string, from: string, random: () => number): ActionResult {
  const bad = requireTurn(s, playerId, ['steal']);
  if (bad) return bad;
  if (!s.stealFrom.includes(from)) return fail('NOT_ALLOWED', '동상이나 해적선을 옮긴 칸에 닿은 사람 중에서 고르세요.');
  stealOne(s, playerId, from, random);
  s.stealFrom = [];
  s.step = s.resumeStep;
  return OK;
}

/** 비용과 보유 한도를 확인한다 */
function checkPiece(s: GameState, playerId: string, kind: PieceKind, free = false): ActionResult | null {
  if (pieceCount(s.buildings, s.roads, playerId, kind, s.ships) >= pieceLimit(s, kind)) {
    return fail('LIMIT', `${PIECE_LABEL[kind]}은(는) 최대 ${pieceLimit(s, kind)}개까지 가질 수 있습니다.`);
  }
  if (!free && !hasBundle(s.players[playerId].resources, PIECE_COST[kind])) {
    return fail('NOT_ENOUGH', `${PIECE_LABEL[kind]}을(를) 지으려면 ${bundleLabel(PIECE_COST[kind])}가 필요합니다.`);
  }
  return null;
}

/** 길 건설 카드로 공짜 길(또는 배)을 더 놓을 수 있는 자리가 있는지 (개수 제한 안에서) */
function freePieceSpots(s: GameState, playerId: string): { roads: EdgeId[]; ships: EdgeId[] } {
  const board = boardOf(s);
  const roomFor = (kind: 'road' | 'ship') => pieceCount(s.buildings, s.roads, playerId, kind, s.ships) < pieceLimit(s, kind);
  return {
    roads: roomFor('road') ? buildableRoads(board, s.buildings, s.roads, playerId, s.ships) : [],
    ships: roomFor('ship') ? buildableShips(board, s.buildings, s.roads, s.ships, playerId, s.pirate) : [],
  };
}

/** 길 건설 카드로 하나를 놓은 뒤: 남은 공짜 수를 줄이고, 더 놓을 곳이 없으면 원래 단계로 돌아간다. */
function afterFreePiece(s: GameState, playerId: string): void {
  s.freeRoads -= 1;
  const spots = freePieceSpots(s, playerId);
  if (s.freeRoads <= 0 || (!spots.roads.length && !spots.ships.length)) {
    s.freeRoads = 0;
    s.step = s.resumeStep;
  }
}

function doBuildRoad(s: GameState, playerId: string, edgeId: EdgeId): ActionResult {
  const bad = requireTurn(s, playerId, ['main', 'road_building']);
  if (bad) return bad;
  if (!boardOf(s).edgeMap[edgeId]) return fail('SPOT_INVALID', '보드에 없는 변입니다.');
  if (roadAt(s.roads, edgeId)) return fail('SPOT_TAKEN', '이미 길이 있는 변입니다.');
  if (shipAt(s.ships, edgeId)) return fail('SPOT_TAKEN', '배가 떠 있는 변입니다.');
  if (!buildableRoads(boardOf(s), s.buildings, s.roads, playerId, s.ships).includes(edgeId)) {
    return fail('NOT_CONNECTED', '길은 내 마을·도시나 내 길에 이어서만 놓을 수 있습니다.');
  }
  const free = s.step === 'road_building';
  const err = checkPiece(s, playerId, 'road', free);
  if (err) return err;
  if (!free) payToBank(s, s.players[playerId].resources, PIECE_COST.road);
  s.roads.push({ edgeId, owner: playerId, builtTurn: s.turn });
  pushEvent(s, { kind: 'build', player: playerId, piece: 'road', at: edgeId, ...(free ? { free: true } : {}) });
  if (free) afterFreePiece(s, playerId);
  afterBuild(s, playerId);
  return OK;
}

/** 배 띄우기: 바다에 닿은 빈 변에, 내 마을·도시나 내 배에 이어서. 길 건설 카드의 공짜 길 대신 띄워도 된다. */
function doBuildShip(s: GameState, playerId: string, edgeId: EdgeId): ActionResult {
  const bad = requireTurn(s, playerId, ['main', 'road_building']);
  if (bad) return bad;
  const net = boardOf(s).sea;
  if (!net) return fail('NOT_ALLOWED', '이 맵에서는 배를 띄울 수 없습니다.');
  if (!net.edgeMap[edgeId]) return fail('SPOT_INVALID', '바다에 닿은 변에만 배를 띄울 수 있습니다.');
  if (shipAt(s.ships, edgeId)) return fail('SPOT_TAKEN', '이미 배가 떠 있는 변입니다.');
  if (roadAt(s.roads, edgeId)) return fail('SPOT_TAKEN', '이미 길이 있는 변입니다.');
  if (pirateEdges(net, s.pirate).has(edgeId)) return fail('NOT_ALLOWED', '해적선이 선 바다 칸 둘레에는 배를 띄울 수 없습니다.');
  if (!buildableShips(boardOf(s), s.buildings, s.roads, s.ships, playerId, s.pirate).includes(edgeId)) {
    return fail('NOT_CONNECTED', '배는 내 마을·도시나 내 배에 이어서만 띄울 수 있습니다. 길 끝에서는 마을을 지어야 바다로 나갑니다.');
  }
  const free = s.step === 'road_building';
  const err = checkPiece(s, playerId, 'ship', free);
  if (err) return err;
  if (!free) payToBank(s, s.players[playerId].resources, PIECE_COST.ship);
  s.ships.push({ edgeId, owner: playerId, builtTurn: s.turn });
  pushEvent(s, { kind: 'build', player: playerId, piece: 'ship', at: edgeId, ...(free ? { free: true } : {}) });
  if (free) afterFreePiece(s, playerId);
  afterBuild(s, playerId);
  return OK;
}

/** 배 옮기기: 항로 끝의 내 배 한 척을 배를 띄울 수 있는 다른 변으로. 한 턴에 한 번, 이번 턴에 띄운 배는 안 된다. */
function doMoveShip(s: GameState, playerId: string, from: EdgeId, to: EdgeId): ActionResult {
  const bad = requireTurn(s, playerId, ['main']);
  if (bad) return bad;
  if (!boardOf(s).sea) return fail('NOT_ALLOWED', '이 맵에서는 배를 띄울 수 없습니다.');
  const problem = shipMoveProblem(s, playerId, from);
  if (problem) return fail('NOT_ALLOWED', problem);
  if (!shipMoveTargets(s, playerId, from).includes(to)) {
    return fail('NOT_CONNECTED', '배는 내 마을·도시나 내 다른 배에 이어지는 빈 바닷길로만 옮길 수 있습니다.');
  }
  shipAt(s.ships, from)!.edgeId = to;
  s.shipMoved = true;
  pushEvent(s, { kind: 'move_ship', player: playerId, from, to });
  afterBuild(s, playerId);
  return OK;
}

function doBuildVillage(s: GameState, playerId: string, vertexId: VertexId): ActionResult {
  const bad = requireTurn(s, playerId, ['main']);
  if (bad) return bad;
  if (!boardOf(s).vertexMap[vertexId]) return fail('SPOT_INVALID', '보드에 없는 꼭짓점입니다.');
  if (buildingAt(s.buildings, vertexId)) return fail('SPOT_TAKEN', '이미 마을이나 도시가 있는 꼭짓점입니다.');
  if (!vertexOpen(boardOf(s), s.buildings, vertexId)) return fail('TOO_CLOSE', '바로 옆 꼭짓점에 마을이 있어 지을 수 없습니다.');
  if (!buildableVillages(boardOf(s), s.buildings, s.roads, playerId, s.ships).includes(vertexId)) {
    return fail('NOT_CONNECTED', boardOf(s).sea ? '마을은 내 길이나 배가 닿은 꼭짓점에만 지을 수 있습니다.' : '마을은 내 길이 닿은 꼭짓점에만 지을 수 있습니다.');
  }
  const err = checkPiece(s, playerId, 'village');
  if (err) return err;
  payToBank(s, s.players[playerId].resources, PIECE_COST.village);
  s.buildings.push({ vertexId, owner: playerId, kind: 'village', builtTurn: s.turn });
  pushEvent(s, { kind: 'build', player: playerId, piece: 'village', at: vertexId });
  // 새 섬 보너스 (섬 맵): 작은 섬에 처음 지은 마을이면 그 섬마다 한 번 2점 (다른 사람이 먼저 지었어도 받는다).
  const island = smallIslandAt(boardOf(s), vertexId);
  if (island !== null && !(s.islandBonus[playerId] ?? []).includes(island)) {
    (s.islandBonus[playerId] ??= []).push(island);
    pushEvent(s, { kind: 'island_bonus', player: playerId, island, points: ISLAND_BONUS_POINTS });
  }
  afterBuild(s, playerId);
  return OK;
}

function doBuildCity(s: GameState, playerId: string, vertexId: VertexId): ActionResult {
  const bad = requireTurn(s, playerId, ['main']);
  if (bad) return bad;
  const b = buildingAt(s.buildings, vertexId);
  if (!b || b.owner !== playerId || b.kind !== 'village') return fail('SPOT_INVALID', '도시는 내 마을을 올려서만 지을 수 있습니다.');
  const err = checkPiece(s, playerId, 'city');
  if (err) return err;
  payToBank(s, s.players[playerId].resources, PIECE_COST.city);
  b.kind = 'city';
  b.builtTurn = s.turn;
  pushEvent(s, { kind: 'build', player: playerId, piece: 'city', at: vertexId });
  afterBuild(s, playerId);
  return OK;
}

function afterBuild(s: GameState, playerId: string): void {
  updateLongestRoad(s);
  afterAction(s);
  checkWin(s, playerId);
}

function doBuyDev(s: GameState, playerId: string, random: () => number): ActionResult {
  const bad = requireTurn(s, playerId, ['main']);
  if (bad) return bad;
  if (!s.devDeck.length) return fail('NO_CARD', '발전 카드가 모두 팔렸습니다.');
  const me = s.players[playerId];
  if (!hasBundle(me.resources, DEV_COST)) return fail('NOT_ENOUGH', `발전 카드는 ${bundleLabel(DEV_COST)}가 필요합니다.`);
  payToBank(s, me.resources, DEV_COST);
  // 개수 제한 없음: 더미가 줄지 않고 처음 구성(종류 비율)에서 무작위로 한 장을 뽑는다.
  const kind = s.unlimited ? s.devDeck[Math.floor(random() * s.devDeck.length)] : s.devDeck.pop()!;
  me.devCards.push({ kind, boughtTurn: s.turn });
  pushEvent(s, { kind: 'buy_dev', player: playerId, detail: kind });
  afterAction(s);
  checkWin(s, playerId);
  return OK;
}

function doPlayDev(s: GameState, playerId: string, action: Extract<GameAction, { type: 'play_dev' }>): ActionResult {
  const bad = requireTurn(s, playerId, ['roll', 'main']);
  if (bad) return bad;
  const kind = action.kind;
  if (!(kind in DEV_DECK) || kind === ('victory' as DevKind)) return fail('BAD_REQUEST', '쓸 수 없는 카드입니다.');
  if (s.devPlayedThisTurn) return fail('NOT_ALLOWED', '발전 카드는 한 턴에 1장만 쓸 수 있습니다.');
  const me = s.players[playerId];
  const idx = me.devCards.findIndex((c) => c.kind === kind && c.boughtTurn < s.turn);
  if (idx < 0) {
    return me.devCards.some((c) => c.kind === kind)
      ? fail('NOT_ALLOWED', '이번 턴에 산 카드는 다음 턴부터 쓸 수 있습니다.')
      : fail('NO_CARD', `${DEV_LABEL[kind]} 카드가 없습니다.`);
  }
  if (kind !== 'knight' && s.step !== 'main' && kind !== 'road_building' && kind !== 'year_of_plenty' && kind !== 'monopoly') {
    return fail('WRONG_STEP', stepHint(s.step));
  }
  if (kind === 'road_building') {
    // 섬 맵에서는 공짜 길 대신 배를 띄워도 되므로 길과 배 중 놓을 수 있는 쪽의 남은 개수를 더한다.
    const spots = freePieceSpots(s, playerId);
    const left = (k: 'road' | 'ship') => pieceLimit(s, k) - pieceCount(s.buildings, s.roads, playerId, k, s.ships);
    const room = Math.min(2, (spots.roads.length ? left('road') : 0) + (spots.ships.length ? left('ship') : 0));
    if (room <= 0) return fail('NOT_ALLOWED', boardOf(s).sea ? '공짜 길이나 배를 놓을 자리가 없습니다.' : '공짜 길을 놓을 자리가 없습니다.');
    me.devCards.splice(idx, 1);
    s.devPlayedThisTurn = true;
    s.resumeStep = s.step;
    s.freeRoads = room;
    s.step = 'road_building';
    pushEvent(s, { kind: 'play_dev', player: playerId, card: 'road_building' });
    return OK;
  }
  if (kind === 'year_of_plenty') {
    if (action.kind !== 'year_of_plenty' || action.resources.length !== 2 || !action.resources.every((r) => RESOURCES.includes(r))) {
      return fail('BAD_REQUEST', '받을 자원 2개를 고르세요.');
    }
    const want = emptyBundle();
    for (const r of action.resources) want[r] += 1;
    const lack = s.bank ? RESOURCES.find((r) => want[r] > s.bank![r]) : undefined;
    if (lack) return fail('NOT_ENOUGH', `은행에 ${RESOURCE_LABEL[lack]}이(가) ${s.bank![lack]}장밖에 없습니다.`);
    me.devCards.splice(idx, 1);
    s.devPlayedThisTurn = true;
    takeFromBank(s, me.resources, want);
    pushEvent(s, { kind: 'play_dev', player: playerId, card: 'year_of_plenty', resources: [...action.resources] });
    afterAction(s);
    return OK;
  }
  if (kind === 'monopoly') {
    if (action.kind !== 'monopoly' || !RESOURCES.includes(action.resource)) return fail('BAD_REQUEST', '자원 한 종류를 고르세요.');
    me.devCards.splice(idx, 1);
    s.devPlayedThisTurn = true;
    let amount = 0;
    for (const id of s.order) {
      if (id === playerId) continue;
      amount += s.players[id].resources[action.resource];
      s.players[id].resources[action.resource] = 0;
    }
    me.resources[action.resource] += amount;
    pushEvent(s, { kind: 'play_dev', player: playerId, card: 'monopoly', resources: [action.resource], amount });
    afterAction(s);
    return OK;
  }
  // 기사: 동상을 옮기고 빼앗는다. 굴리기 전에 썼으면 끝난 뒤 roll 단계로 돌아간다.
  me.devCards.splice(idx, 1);
  me.knightsPlayed += 1;
  s.devPlayedThisTurn = true;
  s.resumeStep = s.step;
  s.step = 'robber';
  closeAllTrades(s, 'cancelled');
  pushEvent(s, { kind: 'play_dev', player: playerId, card: 'knight' });
  updateLargestArmy(s, playerId);
  checkWin(s, playerId);
  return OK;
}

/** 은행·교역로에 낼 묶음 수: 자원마다 (낸 개수 ÷ 내 비율)의 합. 비율의 배수가 아니면 null */
export function bankUnits(give: Bundle, ratios: Record<Resource, number>): number | null {
  let units = 0;
  for (const r of RESOURCES) {
    if (give[r] % ratios[r] !== 0) return null;
    units += give[r] / ratios[r];
  }
  return units;
}

/**
 * 은행·해상 교역로 교환이 성립하지 않는 이유 (성립하면 null).
 * 낼 자원은 자원마다 내 비율(4:1, 교역로 3:1·2:1)의 배수여야 하고 받을 자원 수는 그 묶음 수와 같아야 한다.
 */
export function bankTradeProblem(give: Bundle, get: Bundle, ratios: Record<Resource, number>, have: Bundle, bank: Bundle | null = null): string | null {
  for (const b of [give, get]) {
    if (RESOURCES.some((r) => !Number.isInteger(b[r]) || b[r] < 0)) return '교환 수량이 올바르지 않습니다.';
  }
  if (RESOURCES.some((r) => give[r] > 0 && get[r] > 0)) return '내는 자원과 받는 자원은 서로 달라야 합니다.';
  const odd = RESOURCES.find((r) => give[r] % ratios[r] !== 0);
  if (odd) return `${RESOURCE_LABEL[odd]}은(는) ${ratios[odd]}개씩 내야 합니다.`;
  const units = bankUnits(give, ratios) ?? 0;
  if (units < 1) return '낼 자원을 고르세요.';
  if (!hasBundle(have, give)) return '낼 자원이 모자랍니다.';
  const want = bundleTotal(get);
  if (want !== units) return want < units ? `받을 자원을 ${units - want}개 더 고르세요.` : `받을 자원은 ${units}개까지 고를 수 있습니다.`;
  const lack = bank ? RESOURCES.find((r) => get[r] > bank[r]) : undefined;
  if (lack) return `은행에 ${RESOURCE_LABEL[lack]}이(가) ${bank![lack]}장밖에 없습니다.`;
  return null;
}

function doBankTrade(s: GameState, playerId: string, give: Bundle, get: Bundle): ActionResult {
  const bad = requireTurn(s, playerId, ['main']);
  if (bad) return bad;
  const me = s.players[playerId];
  const ratios = tradeRatios(s, playerId);
  const problem = bankTradeProblem(give, get, ratios, me.resources, s.bank);
  if (problem) return fail(problem === '낼 자원이 모자랍니다.' ? 'NOT_ENOUGH' : 'BAD_REQUEST', problem);
  payToBank(s, me.resources, give);
  takeFromBank(s, me.resources, get);
  const harbor = RESOURCES.some((r) => give[r] > 0 && ratios[r] < BANK_RATIO);
  pushEvent(s, { kind: 'bank_trade', player: playerId, give: { ...give }, get: { ...get }, harbor });
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

/**
 * 모두에게(to 없음) 또는 한 사람에게 교환을 제안한다. 받은 사람은 수락·거절하고 제안한 사람이 수락한 사람 중 한 명을 골라 확정한다.
 * 차례인 사람은 제안을 여러 번 낼 수 있고 동시에 MAX_OPEN_TRADES 개까지 열어 둔다.
 */
function doTradePropose(s: GameState, playerId: string, to: string | undefined, give: Bundle, get: Bundle): ActionResult {
  const bad = requireTurn(s, playerId, ['main']);
  if (bad) return bad;
  if (s.trades.filter((t) => t.from === playerId).length >= MAX_OPEN_TRADES) {
    return fail('TRADE_OPEN', `교환 제안은 동시에 ${MAX_OPEN_TRADES}개까지 열어 둘 수 있습니다. 하나를 취소하거나 응답을 기다리세요.`);
  }
  // 'constructor' 같은 이름이 객체 기본 속성으로 통과하지 않도록 자기 속성인지 확인한다.
  if (to !== undefined && (to === playerId || !Object.prototype.hasOwnProperty.call(s.players, to))) {
    return fail('TRADE_INVALID', '교환할 상대를 다시 고르세요.');
  }
  const bundleErr = validateTradeBundles(give, get);
  if (bundleErr) return fail('TRADE_INVALID', bundleErr);
  const me = s.players[playerId];
  // 상대 보유량은 여기서 확인하지 않는다. 확인 결과가 상대의 비공개 자원을 드러내기 때문이다.
  if (!hasBundle(me.resources, give)) return fail('NOT_ENOUGH', '제안한 자원을 모두 가지고 있지 않습니다.');

  const targets = to === undefined ? s.order.filter((id) => id !== playerId) : [to];
  const same = (x: Bundle, y: Bundle) => RESOURCES.every((r) => x[r] === y[r]);
  if (s.trades.some((t) => t.from === playerId && same(t.give, give) && same(t.get, get) && t.to.join() === targets.join())) {
    return fail('TRADE_OPEN', '같은 내용의 제안이 이미 열려 있습니다.');
  }
  s.tradeSeq += 1;
  s.trades.push({
    id: s.tradeSeq,
    from: playerId,
    to: targets,
    give: { ...give },
    get: { ...get },
    responses: Object.fromEntries(targets.map((id) => [id, 'pending' as TradeResponse])),
  });
  pushEvent(s, { kind: 'trade_proposed', from: playerId, to: [...targets], tradeId: s.tradeSeq, give: { ...give }, get: { ...get } });
  return OK;
}

function findTrade(s: GameState, tradeId: number): TradeOffer | undefined {
  return s.trades.find((t) => t.id === tradeId);
}

function closeTrade(s: GameState, t: TradeOffer, reason: TradeCloseReason): void {
  const i = s.trades.indexOf(t);
  if (i < 0) return;
  s.trades.splice(i, 1);
  pushEvent(s, { kind: 'trade_closed', from: t.from, tradeId: t.id, reason });
}

function closeAllTrades(s: GameState, reason: TradeCloseReason): void {
  for (const t of [...s.trades]) closeTrade(s, t, reason);
}

/** 받은 사람 쪽 요청의 공통 확인: 열린 제안인지, 이 사람이 받은 제안인지. 통과하면 그 제안을 돌려준다. */
function incomingTrade(s: GameState, playerId: string, tradeId: number): TradeOffer | Extract<ActionResult, { ok: false }> {
  if (s.phase !== 'playing') return { ok: false, code: 'WRONG_PHASE', message: '지금은 교환할 수 없습니다.' };
  const t = findTrade(s, tradeId);
  if (!t) return { ok: false, code: 'TRADE_GONE', message: '이미 처리되었거나 닫힌 교환 제안입니다.' };
  if (!t.to.includes(playerId)) return { ok: false, code: 'NOT_ALLOWED', message: '교환 제안을 받은 사람만 응답할 수 있습니다.' };
  return t;
}

/** 수락: 내가 낼 자원이 있는지 확인하고 표시만 한다. 실제로 옮기는 것은 제안한 사람이 확정할 때다. */
function doTradeAccept(s: GameState, playerId: string, tradeId: number): ActionResult {
  const t = incomingTrade(s, playerId, tradeId);
  if ('ok' in t) return t;
  if (t.responses[playerId] === 'accepted') return fail('NOT_ALLOWED', '이미 수락했습니다. 제안한 사람이 고르기를 기다리세요.');
  if (currentPlayer(s) !== t.from || s.step !== 'main') {
    closeTrade(s, t, 'turn_end');
    return { ok: false, code: 'TRADE_GONE', message: '제안한 사람의 차례가 지나 교환이 닫혔습니다.' };
  }
  if (!hasBundle(s.players[t.from].resources, t.give)) {
    closeTrade(s, t, 'unaffordable');
    return { ok: false, code: 'TRADE_GONE', message: '제안한 사람의 자원이 바뀌어 교환이 닫혔습니다.' };
  }
  if (!hasBundle(s.players[playerId].resources, t.get)) return fail('NOT_ENOUGH', '요청받은 자원이 부족해 수락할 수 없습니다.');
  t.responses[playerId] = 'accepted';
  pushEvent(s, { kind: 'trade_response', player: playerId, from: t.from, tradeId: t.id, response: 'accepted' });
  return OK;
}

/** 거절 (수락했다가 마음을 바꿔도 된다). 받은 사람이 모두 거절하면 제안이 닫힌다. */
function doTradeReject(s: GameState, playerId: string, tradeId: number): ActionResult {
  const t = incomingTrade(s, playerId, tradeId);
  if ('ok' in t) return t;
  if (t.responses[playerId] === 'rejected') return fail('NOT_ALLOWED', '이미 거절했습니다.');
  t.responses[playerId] = 'rejected';
  pushEvent(s, { kind: 'trade_response', player: playerId, from: t.from, tradeId: t.id, response: 'rejected' });
  if (t.to.every((id) => t.responses[id] === 'rejected')) closeTrade(s, t, 'rejected');
  return OK;
}

/**
 * 제안한 사람이 수락한 사람 중 한 명을 골라 교환을 확정한다. 양쪽 잔고를 다시 확인한 뒤 한 번에 옮기고 제안을 닫는다.
 * 같은 제안을 두 번 확정하면 두 번째 요청은 제안이 이미 닫혀 거절된다.
 * 옮긴 뒤에는 남은 제안을 다시 본다 (같은 자원을 여러 제안에 걸어 두었을 수 있다).
 */
function doTradeConfirm(s: GameState, playerId: string, tradeId: number, partner: string): ActionResult {
  const t = findTrade(s, tradeId);
  if (!t) return fail('TRADE_GONE', '이미 처리되었거나 닫힌 교환 제안입니다.');
  if (t.from !== playerId) return fail('NOT_ALLOWED', '제안한 사람만 교환을 확정할 수 있습니다.');
  const bad = requireTurn(s, playerId, ['main']);
  if (bad) return bad;
  if (!t.to.includes(partner) || t.responses[partner] !== 'accepted') return fail('NOT_ALLOWED', '수락한 사람 중에서 고르세요.');
  const from = s.players[t.from];
  const other = s.players[partner];
  if (!hasBundle(from.resources, t.give)) return fail('NOT_ENOUGH', '제안한 자원을 모두 가지고 있지 않습니다.');
  if (!hasBundle(other.resources, t.get)) return fail('NOT_ENOUGH', '상대의 자원이 바뀌어 지금은 교환할 수 없습니다.');

  pay(from.resources, t.give);
  gain(other.resources, t.give);
  pay(other.resources, t.get);
  gain(from.resources, t.get);
  s.trades.splice(s.trades.indexOf(t), 1);
  pushEvent(s, { kind: 'trade_accepted', from: t.from, to: partner, tradeId: t.id, give: { ...t.give }, get: { ...t.get } });
  afterAction(s);
  return OK;
}

function doTradeCancel(s: GameState, playerId: string, tradeId: number): ActionResult {
  const t = findTrade(s, tradeId);
  if (!t) return fail('TRADE_GONE', '이미 처리되었거나 닫힌 교환 제안입니다.');
  if (t.from !== playerId) return fail('NOT_ALLOWED', '제안한 사람만 취소할 수 있습니다.');
  closeTrade(s, t, 'cancelled');
  return OK;
}

function doEndTurn(s: GameState, playerId: string): ActionResult {
  const bad = requireTurn(s, playerId, ['main']);
  if (bad) return bad;
  closeAllTrades(s, 'turn_end');
  pushEvent(s, { kind: 'turn_end', player: playerId });
  s.current = (s.current + 1) % s.order.length;
  s.turn += 1;
  s.step = 'roll';
  s.devPlayedThisTurn = false;
  s.shipMoved = false;
  s.freeRoads = 0;
  s.stealFrom = [];
  s.resumeStep = 'main';
  return OK;
}

/**
 * 자원이 바뀐 뒤 열린 제안을 다시 본다 (건설·발전 카드·은행 교환·교환 확정).
 * 제안한 자원이 모자라면 그 제안을 닫고, 수락했던 사람의 자원이 모자라게 되면(독점 카드, 다른 교환 등) 그 사람의 수락을 되돌린다.
 */
function afterAction(s: GameState): void {
  for (const t of [...s.trades]) {
    if (!hasBundle(s.players[t.from].resources, t.give)) {
      closeTrade(s, t, 'unaffordable');
      continue;
    }
    for (const id of t.to) {
      if (t.responses[id] === 'accepted' && !hasBundle(s.players[id].resources, t.get)) t.responses[id] = 'pending';
    }
  }
}

/**
 * 최장 교역로: 길과 배를 이어 5칸 이상 가장 긴 한 사람. 가진 사람과 같은 길이면 가진 사람이 지키고, 다른 사람끼리 비기면 아무도 갖지 않는다.
 * 방장이 최장 교역로를 끄면 아무도 갖지 않는다.
 */
function updateLongestRoad(s: GameState): void {
  if (s.longestRoadAward === false) return;
  const lens = Object.fromEntries(s.order.map((id) => [id, longestRoadLength(boardOf(s), s.roads, s.buildings, id, s.ships)]));
  const max = Math.max(...Object.values(lens));
  const prev = s.longestRoad.holder;
  let holder: string | null;
  if (max < LONGEST_ROAD_MIN) holder = null;
  else if (prev && lens[prev] === max) holder = prev;
  else {
    const leaders = s.order.filter((id) => lens[id] === max);
    holder = leaders.length === 1 ? leaders[0] : null;
  }
  s.longestRoad = { holder, length: holder ? lens[holder] : max };
  if (holder !== prev) pushEvent(s, { kind: 'award', award: 'longest_road', player: holder, previous: prev, size: holder ? lens[holder] : max });
}

/** 최강 기사단: 기사 3장 이상, 지금 가진 사람보다 많이 쓴 사람에게 넘어간다. 방장이 끄면 아무도 갖지 않는다. */
function updateLargestArmy(s: GameState, playerId: string): void {
  if (s.largestArmyAward === false) return;
  const n = s.players[playerId].knightsPlayed;
  const prev = s.largestArmy.holder;
  if (n < LARGEST_ARMY_MIN || prev === playerId) {
    if (prev === playerId) s.largestArmy.size = n;
    return;
  }
  const prevN = prev ? s.players[prev].knightsPlayed : 0;
  if (n > prevN) {
    s.largestArmy = { holder: playerId, size: n };
    pushEvent(s, { kind: 'award', award: 'largest_army', player: playerId, previous: prev, size: n });
  }
}

/** 자기 턴에 승점(숨긴 승점 카드 포함)이 승리 점수(기본 10점)에 닿으면 바로 이긴다. */
function checkWin(s: GameState, playerId: string): void {
  if (s.phase !== 'playing' || currentPlayer(s) !== playerId) return;
  if (victoryPoints(s, playerId, true) < s.winPoints) return;
  s.phase = 'finished';
  s.trades = [];
  s.result = computeResult(s, playerId);
  pushEvent(s, { kind: 'game_end', winners: [playerId] });
}

/** 승점(숨긴 카드 포함) → 남은 자원 총량 순으로 순위를 매긴다. 이긴 사람은 10점에 먼저 닿은 사람이다. */
export function computeResult(s: GameState, winner: string): GameResult {
  const entries = s.order.map((id) => ({
    playerId: id,
    score: victoryPoints(s, id, true),
    resourceTotal: bundleTotal(s.players[id].resources),
    rank: 0,
  }));
  for (const e of entries) {
    if (e.playerId === winner) {
      e.rank = 1;
      continue;
    }
    e.rank = 2 + entries.filter((o) => o.playerId !== winner && (o.score > e.score || (o.score === e.score && o.resourceTotal > e.resourceTotal))).length;
  }
  const ranking: RankEntry[] = [...entries].sort((a, b) => a.rank - b.rank || s.order.indexOf(a.playerId) - s.order.indexOf(b.playerId));
  return { ranking, winners: [winner], decidedBy: 'score' };
}

// ───────────────────────── 차례 시간 ─────────────────────────

/** 지금 시간이 흐르는 사람들: 순서 정하기는 아직 굴리지 않은 사람 모두, 7 버리기는 버려야 하는 사람 모두, 그 밖에는 차례인 사람 */
export function clockHolders(s: GameState): string[] {
  if (s.phase === 'order') return [...s.startPending];
  if (s.phase === 'placement') {
    const p = placementPlayer(s);
    return p ? [p] : [];
  }
  if (s.phase !== 'playing') return [];
  if (s.step === 'discard') return s.order.filter((id) => s.discards[id]);
  if (s.step === 'gold') return s.order.filter((id) => s.goldPicks[id]);
  const c = currentPlayer(s);
  return c ? [c] : [];
}

/**
 * 차례 시계를 새로 맞출 때를 가리는 열쇠. 이 값이 바뀌면 시간을 처음부터 다시 잰다.
 * 순서 정하기는 한 바퀴(같은 수가 나와 다시 굴리면 새 바퀴), 시작 배치는 한 사람의 마을과 길, 진행 중에는 한 턴.
 * 7이 나와 다른 사람들이 버리는 동안은 따로 재고, 다 버리면 차례인 사람이 다시 처음부터 잰다.
 */
export function clockKey(s: GameState): string | null {
  if (s.phase === 'order') {
    const round = s.startPending.length ? Math.min(...s.startPending.map((id) => s.startRolls[id].length)) + 1 : 0;
    return `order:${round}`;
  }
  if (s.phase === 'placement') return `place:${s.placementIndex}`;
  if (s.phase === 'playing') return `turn:${s.turn}:${s.step === 'discard' || s.step === 'gold' ? s.step : 'own'}`;
  return null;
}

/** 시간이 다 된 금광 고르기: 은행에 남은 자원 중에서 내가 가장 적게 가진 것부터 고른다 */
function autoGoldBundle(s: GameState, playerId: string): Bundle {
  const out = emptyBundle();
  const have = { ...s.players[playerId].resources };
  for (let i = 0; i < goldPickCount(s, playerId); i++) {
    const r = [...RESOURCES].filter((x) => !s.bank || s.bank[x] > out[x]).sort((a, b) => have[a] + out[a] - (have[b] + out[b]))[0];
    if (!r) break;
    out[r] += 1;
  }
  return out;
}

function pickRandom<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

/** 시간이 다 된 시작 배치에서 대신 고를 마을 자리: 닿은 숫자 패의 점(나올 확률)이 가장 많은 곳 중 하나 */
function autoSetupVertex(s: GameState, random: () => number): VertexId {
  const free = placeableVertices(boardOf(s), s.buildings);
  const pips = (v: VertexId) => boardOf(s).vertexMap[v].tiles.reduce((n, t) => n + (s.numbers[t] ? numberPips(s.numbers[t]) : 0), 0);
  const best = Math.max(...free.map(pips));
  return pickRandom(
    free.filter((v) => pips(v) === best),
    random,
  );
}

/** 시간이 다 된 7 버리기: 가진 카드 중에서 무작위로 고른다 */
function autoDiscardBundle(have: Bundle, count: number, random: () => number): Bundle {
  const pool = RESOURCES.flatMap((r) => Array<Resource>(have[r]).fill(r));
  const out = emptyBundle();
  for (let i = 0; i < count && pool.length; i++) out[pool.splice(Math.floor(random() * pool.length), 1)[0]] += 1;
  return out;
}

/** 시간이 다 된 동상 옮기기: 남의 마을·도시가 닿고 내 것은 닿지 않은 칸 중에서 고른다 */
function autoRobberTile(s: GameState, playerId: string, random: () => number): TileId {
  const score = (tileId: TileId) =>
    s.buildings.filter((b) => boardOf(s).vertexMap[b.vertexId]?.tiles.includes(tileId)).reduce((n, b) => n + (b.owner === playerId ? -10 : 1), 0);
  const tiles = boardOf(s).tiles.map((t) => t.id).filter((id) => id !== s.robber);
  const best = Math.max(...tiles.map(score));
  return pickRandom(
    tiles.filter((t) => score(t) === best),
    random,
  );
}

/**
 * 차례 시간이 다 되면 서버가 대신 진행한다. 시간이 흐르던 사람(clockHolders)마다 기록을 남기고,
 *  - 순서 정하기: 아직 굴리지 않은 사람의 주사위를 굴린다
 *  - 시작 배치: 점이 가장 많은 자리에 마을을, 그 마을에 붙여 길을 놓는다
 *  - 7 버리기: 버려야 할 장수만큼 무작위로 버린다
 *  - 금광 고르기: 은행에 남은 자원 중 가장 적게 가진 것부터 고른다
 *  - 차례인 사람: 굴리기·동상·빼앗기·공짜 길을 무작위로 마치고 턴을 넘긴다
 * 무엇이든 바꿨으면 true.
 */
export function autoPlay(s: GameState, random: () => number = Math.random): boolean {
  const before = s.eventSeq;
  if (s.phase === 'order') {
    for (const id of [...s.startPending]) {
      pushEvent(s, { kind: 'timeout', player: id });
      doOrderRoll(s, id, random);
    }
  } else if (s.phase === 'placement') {
    const p = placementPlayer(s);
    if (p) {
      pushEvent(s, { kind: 'timeout', player: p });
      if (!s.setupVillage) doPlaceVillage(s, p, autoSetupVertex(s, random));
      const edges = s.setupVillage ? setupRoadEdges(boardOf(s), s.roads, s.setupVillage) : [];
      if (edges.length) doPlaceRoad(s, p, pickRandom(edges, random));
    }
  } else if (s.phase === 'playing' && s.step === 'discard') {
    for (const id of s.order.filter((x) => s.discards[x])) {
      pushEvent(s, { kind: 'timeout', player: id });
      doDiscard(s, id, autoDiscardBundle(s.players[id].resources, s.discards[id], random));
    }
  } else if (s.phase === 'playing' && s.step === 'gold') {
    for (const id of s.order.filter((x) => s.goldPicks[x])) {
      pushEvent(s, { kind: 'timeout', player: id });
      doGoldPick(s, id, autoGoldBundle(s, id));
    }
  } else if (s.phase === 'playing') {
    const p = currentPlayer(s);
    if (p) {
      pushEvent(s, { kind: 'timeout', player: p });
      // 한 단계씩 끝까지 진행한다. 7이 나와 다른 사람이 버려야 하거나 금광 자원을 골라야 하면 그 사람들의 시간으로 넘어간다.
      for (let guard = 0; guard < 40 && s.phase === 'playing' && currentPlayer(s) === p && s.step !== 'discard' && s.step !== 'gold'; guard++) {
        if (s.step === 'roll') doRoll(s, p, random);
        else if (s.step === 'robber') doMoveRobber(s, p, autoRobberTile(s, p, random), random);
        else if (s.step === 'steal') doSteal(s, p, pickRandom(s.stealFrom, random), random);
        else if (s.step === 'road_building') {
          const spots = freePieceSpots(s, p);
          if (spots.roads.length && s.freeRoads > 0) doBuildRoad(s, p, pickRandom(spots.roads, random));
          else if (spots.ships.length && s.freeRoads > 0) doBuildShip(s, p, pickRandom(spots.ships, random));
          else {
            s.freeRoads = 0;
            s.step = s.resumeStep;
          }
        } else doEndTurn(s, p);
      }
    }
  }
  if (s.eventSeq === before) return false;
  s.version += 1;
  return true;
}

function pay(have: Bundle, cost: Bundle): void {
  for (const r of RESOURCES) have[r] -= cost[r];
}

function gain(have: Bundle, add: Bundle): void {
  for (const r of RESOURCES) have[r] += add[r];
}

/** 은행에 낸다 (건설·발전 카드·버리기·은행 교환). 무제한 은행이면 그냥 사라진다. */
function payToBank(s: GameState, have: Bundle, cost: Bundle): void {
  pay(have, cost);
  if (s.bank) gain(s.bank, cost);
}

/** 은행에서 받는다. 은행에 그만큼 있는지는 부르는 쪽이 먼저 확인한다. */
function takeFromBank(s: GameState, to: Bundle, add: Bundle): void {
  if (s.bank) pay(s.bank, add);
  gain(to, add);
}

/**
 * 주사위 생산을 은행에서 나눠 준다. 한 자원을 받을 사람들의 몫을 은행이 다 채우지 못하면 그 자원은 아무도 받지 못한다.
 * 받을 사람이 한 명뿐이면 은행에 남은 만큼만 받는다. short 는 몫을 다 채우지 못한 자원이다.
 */
export function settleProduction(bank: Bundle | null, gains: Record<string, Bundle>): { paid: Record<string, Bundle>; short: Resource[] } {
  const paid: Record<string, Bundle> = Object.fromEntries(Object.entries(gains).map(([id, b]) => [id, { ...b }]));
  const short: Resource[] = [];
  if (!bank) return { paid, short };
  for (const r of RESOURCES) {
    const owed = Object.keys(gains).filter((id) => gains[id][r] > 0);
    const total = owed.reduce((n, id) => n + gains[id][r], 0);
    if (total <= bank[r]) continue;
    short.push(r);
    if (owed.length === 1) paid[owed[0]][r] = bank[r];
    else for (const id of owed) paid[id][r] = 0;
  }
  return { paid, short };
}
