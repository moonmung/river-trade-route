// 브라우저 ↔ 서버 Socket.IO 메시지 형식.
import type { Building, Bundle, DevCard, GameEvent, GamePhase, GameResult, GameAction, Harbor, Resource, Road, TileId, TradeResponse, TurnStep } from './types';

export interface LobbyPlayerView {
  id: string;
  nickname: string;
  colorIndex: number;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
}

/** 다른 사람에게도 공개되는 플레이어 정보. 종류별 자원과 발전 카드 종류는 포함하지 않는다. */
export interface GamePlayerView {
  id: string;
  seat: number;
  /** 공개 승점: 마을·도시 + 최장 교역로·최강 기사단 (숨긴 승점 카드는 빠진다) */
  score: number;
  resourceTotal: number;
  /** 손에 든 발전 카드 장수 */
  devCardCount: number;
  /** 쓴 기사 카드 수 */
  knightsPlayed: number;
  /** 가장 길게 이어진 길 */
  roadLength: number;
  villages: number;
  cities: number;
  roads: number;
}

/** 열린 교환 제안. 모두에게 제안하므로 내용과 응답은 모두에게 보인다 (종류별 보유량은 들어 있지 않다). */
export interface TradeView {
  id: number;
  from: string;
  /** 제안을 받은 사람들 */
  to: string[];
  /** 제안한 사람이 내는 자원 */
  give: Bundle;
  /** 제안한 사람이 받는 자원 */
  get: Bundle;
  responses: Record<string, TradeResponse>;
}

export interface GameView {
  phase: GamePhase;
  /** 진행 턴 번호 (시작 배치 중에는 0) */
  turn: number;
  order: string[];
  placementOrder: string[];
  placementPlayerId: string | null;
  currentPlayerId: string | null;
  step: TurnStep;
  dice: [number, number] | null;
  /** 7이 나와 아직 버려야 하는 장수 */
  discards: Record<string, number>;
  /** 기사단 동상을 옮긴 뒤 빼앗을 수 있는 상대 */
  stealFrom: string[];
  /** 기사단 동상이 선 칸 */
  robber: TileId;
  /** 칸마다 놓인 주사위 숫자 */
  numbers: Record<TileId, number>;
  harbors: Harbor[];
  buildings: Building[];
  roads: Road[];
  devDeckCount: number;
  devPlayedThisTurn: boolean;
  freeRoads: number;
  longestRoad: { holder: string | null; length: number };
  largestArmy: { holder: string | null; size: number };
  players: GamePlayerView[];
  /** 이 화면의 주인 자원만 종류별로 들어 있다. */
  myResources: Bundle;
  /** 이 화면의 주인이 든 발전 카드 */
  myDevCards: DevCard[];
  /** 이 화면의 주인이 쓸 수 있는 은행 교환 비율 */
  myTradeRatios: Record<Resource, number>;
  /** 이 화면의 주인 승점 (숨긴 승점 카드 포함) */
  myPoints: number;
  trade: TradeView | null;
  events: GameEvent[];
  result: GameResult | null;
  version: number;
}

export interface RoomView {
  code: string;
  phase: 'lobby' | 'game';
  hostId: string;
  /** 이 화면의 주인 플레이어 ID */
  you: string;
  players: LobbyPlayerView[];
  game: GameView | null;
  gameNumber: number;
  minPlayers: number;
  maxPlayers: number;
}

export interface RoomPeek {
  code: string;
  phase: 'lobby' | 'game';
  playerCount: number;
  maxPlayers: number;
  joinable: boolean;
  hostNickname: string;
}

export interface SessionInfo {
  roomCode: string;
  playerId: string;
  token: string;
  nickname: string;
}

export interface LanAddress {
  address: string;
  name: string;
  preferred: boolean;
}

export interface ServerInfo {
  port: number;
  lanAddresses: LanAddress[];
}

export type AckFail = { ok: false; error: string; code?: string };
export type AckResult<T extends object = object> = ({ ok: true } & T) | AckFail;
export type Ack<T extends object = object> = (result: AckResult<T>) => void;

export interface ServerToClientEvents {
  state: (view: RoomView) => void;
  'session:invalid': (info: { reason: string }) => void;
  'session:replaced': () => void;
  kicked: () => void;
}

export interface ClientToServerEvents {
  'room:create': (p: { nickname: string }, ack: Ack<SessionInfo>) => void;
  'room:join': (p: { code: string; nickname: string }, ack: Ack<SessionInfo>) => void;
  'room:peek': (p: { code: string }, ack: Ack<RoomPeek>) => void;
  'room:ready': (p: { ready: boolean }, ack: Ack) => void;
  'room:start': (p: Record<string, never>, ack: Ack) => void;
  'room:leave': (p: Record<string, never>, ack: Ack) => void;
  'room:kick': (p: { playerId: string }, ack: Ack) => void;
  'room:rematch': (p: Record<string, never>, ack: Ack) => void;
  'game:action': (p: { requestId: string; action: GameAction }, ack: Ack) => void;
}

/** Socket.IO 연결 때 보내는 인증 정보 (재접속 시 같은 자리 복구용) */
export interface HandshakeAuth {
  roomCode?: string;
  token?: string;
}
